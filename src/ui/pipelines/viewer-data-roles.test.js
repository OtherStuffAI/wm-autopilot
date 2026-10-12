import { expect, test } from "bun:test";
import { viewerDefinition } from "../../pipelines/pipeline-viewer-dto.ts";
import { definitionDto } from "./viewer-contract.js";
import { viewerMapping } from "./viewer-mapping.js";
import { operationLinks, dataConnectionGroups, rolePorts } from "./viewer-data-roles.js";
import { createReviewView } from "./viewer-review-view.js";
const row = (label, path, role = "operation") => ({label, path, role});
function fixture() {
  const definition = definitionDto(viewerDefinition({id:"example", name:"example",spec:{name:"example",steps:[
    {name:"normalise",type:"code",function:"normalise",assign:"$.context",display:{out:[row("Original request","$.workPlan.originalPrompt"),row("Requirements","$.workPlan.instructions"),row("Thread ID","$.workPlan.threadId","carried")]}},
    {name:"do",type:"agent",input:{pick:{workPlan:"$.context.workPlan",legacy:"$.unknown"}},prompt:"Configured worker instructions",assign:"$.workerResult",display:{in:[row("Original request","$.workPlan.originalPrompt"),row("Requirements","$.workPlan.instructions"),row("Thread ID","$.workPlan.threadId","carried")],out:[row("Result","$.result"),row("Evidence","$.evidence")]}},
    {name:"review",type:"agent",input:{pick:{workerOutput:"$.workerResult.result",workerEvidence:"$.workerResult.evidence",threadId:"$.context.workPlan.threadId"}},display:{in:[row("Do result","$.workerOutput"),row("Do evidence","$.workerEvidence"),row("Thread ID","$.threadId","carried")]}}
  ]}}));
  return {definition,nodes:definition.steps,mapping:viewerMapping(definition.steps,definition.wiring)};
}
test("nested operation inputs trace through selected objects and renamed results",()=>{
  const {nodes,mapping}=fixture(), links=operationLinks(mapping,nodes);
  expect(links.map(l=>[l.sourceKey,l.sourcePath,l.targetKey,l.targetPath])).toEqual([
    ["normalise","$.workPlan.originalPrompt","do","$.workPlan.originalPrompt"],
    ["normalise","$.workPlan.instructions","do","$.workPlan.instructions"],
    ["do","$.result","review","$.workerOutput"],["do","$.evidence","review","$.workerEvidence"]]);
  const groups=dataConnectionGroups(links,nodes);
  expect(groups).toHaveLength(2);
  expect(groups[1].labels).toEqual(["Do result","Do evidence"]);
});
test("step selection prioritizes operation fields; explicit toggle reveals carried and unclassified mappings",()=>{
  const {nodes,mapping}=fixture();
  const view=Object.assign(createReviewView(),{nodes,mapping,inspectLabel:"do",inspectPath:"",inspectSide:"",selectedStepKey:"do",queueGeometry(){}});
  expect(view.selectedLinks).toHaveLength(4);
  view.toggleMappings();expect(view.selectedLinks).toHaveLength(6);
  expect(rolePorts(nodes[1].inputs,"carried")).toHaveLength(1);
  expect(rolePorts([{path:"$.legacy"}],"unclassified")).toHaveLength(1);
  expect(nodes[1].review.prompt).toBe("Configured worker instructions");
});
test("carried source used as operation input is labelled context via rather than a produced result",()=>{
  const {nodes,mapping}=fixture();nodes[2].inputs.find(p=>p.path==="$.threadId").role="operation";
  const group=dataConnectionGroups(operationLinks(mapping,nodes),nodes).find(g=>g.sourceKey==="normalise"&&g.targetKey==="review");
  expect(group.sourceLabel).toBe("Context via normalise");
});
test("unknown roles fail clearly and unclassified legacy display remains unclassified",()=>{
  const {definition}=fixture();definition.steps[0].outputs[0].role="plumbing";
  expect(()=>definitionDto(definition)).toThrow("invalid read contract");
  delete definition.steps[0].outputs[0].role;
  expect(definitionDto(definition).steps[0].outputs[0].role).toBeUndefined();
});
test("source provenance and exact role declarations stay inspectable without false input edges",()=>{
  const {nodes,mapping}=fixture();
  expect(nodes[1].review.display.in[0]).toMatchObject({path:"$.workPlan.originalPrompt",role:"operation"});
  nodes[1].inputs[0].source="state";
  expect(operationLinks(mapping,nodes).some(link=>link.targetKey==="do"&&link.targetPath==="$.workPlan.originalPrompt")).toBe(false);
});
test("nested array paths expand whole-object inputs and select their exact retained value",async()=>{
  const { wiringEndpoints, portSelection }=await import("./viewer-projection.js");
  expect(wiringEndpoints({sourcePath:"$.plan",sourceValuePath:"$.plan",targetPath:"$.workPlan",targetPortPaths:["$.workPlan.items[0].text"]})).toEqual([{sourcePath:"$.plan.items[0].text",targetPath:"$.workPlan.items[0].text"}]);
  expect(portSelection({workPlan:{items:[{text:"Actual requirement"}]}},"$.workPlan.items[0].text")).toEqual({status:"present",value:"Actual requirement"});
  expect(portSelection({"quoted-key":{text:"Evidence"}},'$["quoted-key"].text').value).toBe("Evidence");
});
