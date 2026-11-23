'use strict';
const {expect} = require('chai');
const axios = require('axios');
const policy = require('./lib/api-policy');
require.cache[require.resolve('@iobroker/adapter-core')] = {exports:{Adapter:class {
	constructor(){this.log={info:()=>{},debug:()=>{},warn:()=>{},error:()=>{}};} on(){}
}}};
const factory = require('./main');

describe('API request lifecycle', () => {
	let a, post, waits;
	beforeEach(()=>{a=factory({});a.config={};post=axios.post;waits=[];a.waitForRequest=async ms=>waits.push(ms);});
	afterEach(()=>{axios.post=post;});
	it('parses Retry-After seconds and dates and token expiry',()=>{
		expect(policy.retryAfterMs('30')).to.equal(30000);
		expect(policy.retryAfterMs('Tue, 01 Jan 2030 00:00:30 GMT',Date.parse('2030-01-01T00:00:00Z'))).to.equal(30000);
		expect(policy.retryAfterMs('invalid')).to.equal(null);
		expect(policy.tokenExpiry('a.'+Buffer.from(JSON.stringify({exp:123})).toString('base64url')+'.z')).to.equal(123000);
	});
	it('shares concurrent token refresh and reuses a valid token',async()=>{
		a.config={octopusEmail:'test',octopusPassword:'test'};let calls=0;
		axios.post=async()=>{calls++;return {status:200,data:{data:{obtainKrakenToken:{token:'opaque'}}}};};
		await Promise.all([a.ensureOctopusToken(),a.ensureOctopusToken()]);
		await a.ensureOctopusToken();expect(calls).to.equal(1);
		a.octopusTokenExpiresAt=Date.now()-1;await a.ensureOctopusToken();expect(calls).to.equal(2);
	});
	it('defers long rate limits and does not issue requests during cooldown',async()=>{
		a.config.updateInterval = 5;
		let calls=0;axios.post=async()=>{calls++;return {status:429,headers:{'retry-after':'1800'},data:{}};};
		await a.requestOctopus({query:'query X { viewer { id } }'});
		await a.requestOctopus({query:'query X { viewer { id } }'});
		expect(calls).to.equal(1);expect(waits).to.deep.equal([]);
		expect(a.apiCooldowns.values().next().value).to.be.greaterThan(Date.now()+1790000);
	});
	it('uses one configured sync interval as the cooldown floor without extending it on skipped calls', async () => {
		for (const [minutes, header] of [[5, undefined], [7, '30']]) {
			a.config.updateInterval = minutes;
			a.apiCooldowns.clear();
			let calls = 0;
			axios.post = async () => { calls++; return {status:429, headers:{'retry-after':header}, data:{}}; };
			const before = Date.now();
			await a.requestOctopus({query:'query X {}'});
			const until = a.apiCooldowns.values().next().value;
			expect(until).to.be.within(before + minutes * 60000, Date.now() + minutes * 60000);
			const beforeSkip = calls;
			await a.requestOctopus({query:'query X {}'});
			expect(calls).to.equal(beforeSkip);
			expect(a.apiCooldowns.values().next().value).to.equal(until);
		}
	});
	it('bounds GraphQL quota retries and server-error retries without logging in',async()=>{
		let calls=0;axios.post=async()=>{calls++;return {status:200,data:{errors:[{extensions:{errorCode:'KT-CT-1199'}}]}};};
		await a.requestOctopus({query:'query X { viewer { id } }'});
		expect(calls).to.equal(3);expect(waits).to.deep.equal([1000,2000]);
		a.apiCooldowns.clear();calls=0;waits.length=0;
		axios.post=async()=>{calls++;return {status:503,data:{}};};
		await a.requestOctopus({query:'query X { viewer { id } }'});expect(calls).to.equal(3);
	});
	it('never retries mutations on transient server failures',async()=>{
		let calls=0;axios.post=async()=>{calls++;return {status:503,data:{}};};
		await a.requestOctopus({query:'mutation X { action }'});expect(calls).to.equal(1);
	});
	it('refreshes on explicit auth failure only once',async()=>{
		a.config={octopusEmail:'test',octopusPassword:'test'};a.octopusAuthToken='old';
		let auth=0,queries=0;
		axios.post=async(_,payload)=>{
			if(payload.query.startsWith('mutation obtain')) {auth++;return {status:200,data:{data:{obtainKrakenToken:{token:'new'}}}};}
			queries++;return {status:401,data:{}};
		};
		await a.requestOctopus({query:'query X { viewer { id } }'});
		expect(auth).to.equal(1);expect(queries).to.equal(2);
	});
	it('paginates and deduplicates identical intervals',async()=>{
		let calls=0;const node={startAt:'2026-01-01T00:00:00Z',endAt:'2026-01-01T00:15:00Z',value:'1'};
		axios.post=async()=>{calls++;return {status:200,data:{data:{property:{measurements:{
			pageInfo:{hasNextPage:calls===1,endCursor:'cursor'},edges:[{node},...(calls===2?[{node:{...node,startAt:'2026-01-01T00:15:00Z',endAt:'2026-01-01T00:30:00Z'}}]:[])],
		}}}}};};
		const response=await a.fetchMeasurementPages({query:'query X {}',variables:{after:null}});
		expect(response.data.data.account.property.measurements.edges).to.have.length(2);
		expect(calls).to.equal(2);expect(waits).to.deep.equal([250]);
	});
	it('rejects stuck cursors and conflicting repeated intervals',async()=>{
		axios.post=async()=>({status:200,data:{data:{property:{measurements:{pageInfo:{hasNextPage:true,endCursor:'same'},edges:[]}}}}});
		await expect(a.fetchMeasurementPages({query:'query X {}',variables:{after:null}})).to.be.rejectedWith('cursor');
		let calls=0;axios.post=async()=>{calls++;return {status:200,data:{data:{property:{measurements:{pageInfo:{hasNextPage:calls===1,endCursor:'next'},edges:[{node:{startAt:'2026-01-01T00:00:00Z',value:String(calls)}}]}}}}};};
		await expect(a.fetchMeasurementPages({query:'query X {}',variables:{after:null}})).to.be.rejectedWith('Conflicting');
	});
	it('cancels delays and prevents requests and writes after unload',async()=>{
		const timer={};let cleared;
		a.setTimeout=()=>timer;a.clearTimeout=handle=>{cleared=handle;};
		const pending=Object.getPrototypeOf(a).waitForRequest.call(a,60000);
		await a.onUnload(()=>{});
		await expect(pending).to.be.rejectedWith('stopping');
		expect(cleared).to.equal(timer);
		await expect(a.requestOctopus({query:'query X {}'})).to.be.rejectedWith('stopping');
		await expect(a.writeStateObject('x','X',1)).to.be.rejectedWith('stopping');
	});
	it('uses adapter timers and removes the abort listener after a delay',async()=>{
		const controller=new AbortController();let callback,delayMs,cleared=false,removed=false;
		const remove=controller.signal.removeEventListener.bind(controller.signal);
		controller.signal.removeEventListener=(...args)=>{removed=true;return remove(...args);};
		const adapter={setTimeout:(fn,ms)=>{callback=fn;delayMs=ms;return 1;},clearTimeout:()=>{cleared=true;}};
		const pending=policy.delay(250,controller.signal,adapter);
		expect(delayMs).to.equal(250);callback();await pending;
		expect(removed).to.equal(true);controller.abort();expect(cleared).to.equal(false);
	});
	it('does not create a timer when already stopping',async()=>{
		const controller=new AbortController();controller.abort();let scheduled=false;
		await expect(policy.delay(250,controller.signal,{setTimeout:()=>{scheduled=true;}})).to.be.rejectedWith('stopping');
		expect(scheduled).to.equal(false);
	});
});
