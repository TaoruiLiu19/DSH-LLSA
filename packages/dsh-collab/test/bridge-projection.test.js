import test from 'node:test';
import assert from 'node:assert/strict';
import {projectBridgeReport} from '../src/bridge-projection.js';
const manager={select:payload=>({modelInput:JSON.stringify(payload),codec:'json'}),countTokens:text=>text.length};
const base={eventId:'e1',ticketId:'t1',assignmentId:'a1',read:'report/e1',report:{state:'ready',summary:'{"count":0}'},relay:{text:'short native relay'}};
test('ordinary report expansion is rejected; bounded host computation context is delivered intact',()=>{
 assert.equal(projectBridgeReport(base,manager),undefined);
 const computation={receiptId:'receipt',contract:{filter:[],operations:[{op:'count',as:'count'}]},result:{count:0},verificationScope:'bound rule only'};
 const input={...base,reviewContext:{children:{items:[{id:'w1',computation}]}}};
 const projected=projectBridgeReport(input,manager);
 assert.deepEqual(JSON.parse(projected.text).review_context.children.items[0].computation,computation);
 assert.equal(JSON.parse(projected.text).summary,base.report.summary);
 const oversized={...input,reviewContext:{children:{items:[{computation:{...computation,result:{data:'x'.repeat(5000)}}}]}}};
 assert.equal(projectBridgeReport(oversized,manager),undefined);
 assert.equal(projectBridgeReport({...base,report:{...base.report,summary:JSON.stringify(computation)}},manager),undefined,'model prose cannot create a host proof');
});
