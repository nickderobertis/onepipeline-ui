import { useState } from "react";
import "./human-actions-mock.css";

// Throwaway visual proposal only. No engine records or mutations are represented.
const nodes = ["publish-api", "publish-ui", "verify-install", "announce-release", "archive-evidence"];
const items = [
  { id: "Q1", scope: "Plan", kind: "Question", plan: "Release", priority: 1, blocking: true, owner: "Active", title: "Which release channel should we use?", nodes, state: "Open" },
  { id: "T1", scope: "Node", kind: "Task", plan: "Release", priority: 2, blocking: true, owner: "Ended", title: "Approve release board copy and key", nodes: nodes.slice(0, 3), state: "Open" },
  { id: "T2", scope: "Host", kind: "Task", plan: "Access", priority: 1, blocking: false, owner: "Ended", title: "Rotate staging credentials", nodes: [], state: "Open" },
  { id: "Q2", scope: "None", kind: "Question", plan: "Access", priority: 2, blocking: false, owner: "Active", title: "Who owns the staging account?", nodes: [], state: "Open" },
  { id: "T3", scope: "None", kind: "Task", plan: "Release", priority: 3, blocking: false, owner: "Active", title: "Archive the launch notes", nodes: [], state: "Open" },
  { id: "T4", scope: "None", kind: "Task", plan: "Access", priority: 3, blocking: false, owner: "Ended", title: "Remove obsolete access request", nodes: [], state: "Dismissed" },
];
const fields = {
  Kind: ["All", "Task", "Question"], Plan: ["All", "Release", "Access"],
  State: ["Open", "All", "Completed", "Answered", "Dismissed", "Approved"],
  Owner: ["All", "Active", "Ended"], Blocking: ["All", "Blocking", "Nonblocking"],
  Priority: ["All", "P1", "P2", "P3"], Scope: ["All", "None", "Node", "Plan", "Host"],
};
export function HumanActionsMock() {
  const [filters, setFilters] = useState<Record<string, string>>({ State: "Open" });
  const [states, setStates] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string>();
  const [receipt, setReceipt] = useState("");
  const [answer, setAnswer] = useState("");
  const [reason, setReason] = useState("");
  const [copy, setCopy] = useState(false);
  const [key, setKey] = useState(false);
  const [error, setError] = useState("");
  const rows = items.map(i => ({ ...i, state: states[i.id] ?? i.state }));
  const visible = rows.filter(i => Object.entries(filters).every(([field, value]) => {
    if (value === "All") return true;
    if (field === "Blocking") return i.blocking === (value === "Blocking");
    if (field === "Priority") return `P${i.priority}` === value;
    return i[field.toLowerCase() as "kind" | "plan" | "state" | "owner" | "scope"] === value;
  })).sort((a,b) => Number(b.blocking)-Number(a.blocking) || a.priority-b.priority || a.id.localeCompare(b.id));
  const current = rows.find(i => i.id === selected);
  function resolve(state: string, text: string) {
    if (!current) return;
    setStates({ ...states, [current.id]: state }); setReceipt(`${current.id} · ${text} · fixture only`); setError("");
  }
  return <section className="human-mock" aria-label="Human actions mock">
    <p className="mock-label">THROWAWAY MOCK · fixture data · no engine writes</p>
    <h2>Human actions <small>this host</small></h2>
    <div className="plan-counts">{["Release", "Access"].map(plan => <article key={plan}><strong>{plan}</strong><span>{rows.filter(i=>i.plan===plan&&i.state==="Open").length} open · {rows.filter(i=>i.plan===plan&&i.state==="Open"&&i.kind==="Task").length} tasks · {rows.filter(i=>i.plan===plan&&i.state==="Open"&&i.kind==="Question").length} questions</span><span>Node preview: {plan === "Release" ? "publish-api · publish-ui · verify-install · +2 more" : "rotate-key · verify-access · revoke-old-key"}</span></article>)}</div>
    <div className="mock-filters">{Object.entries(fields).map(([field, values]) => <label key={field}>{field}<select aria-label={field} value={filters[field] ?? "All"} onChange={e=>setFilters({...filters,[field]:e.target.value})}>{values.map(v=><option key={v}>{v}</option>)}</select></label>)}</div>
    <p className="mock-muted">{visible.length} shown · blocking first, then P1 → P3 · filters combine independently · counts reflect the whole plan</p>
    {receipt && <p role="status" className="mock-receipt">{receipt}</p>}
    <div className="mock-columns"><div>{visible.map(i=><button className="action-card" key={i.id} onClick={()=>{setSelected(i.id);setError("");setAnswer("");setReason("");setCopy(false);setKey(false);}}>
      <span>{i.id} · {i.kind} · {i.plan} · Scope {i.scope} <b>P{i.priority}</b> {i.blocking && <em>BLOCKING</em>}</span><strong>{i.title}</strong>
      <span>{i.state} · Owner {i.owner === "Ended" ? "ended — item retained" : "active"}</span>
      {i.nodes.length>0 && <span>Blocks {i.nodes.length} nodes · {i.nodes.slice(0,3).join(" · ")}{i.nodes.length>3 ? ` · +${i.nodes.length-3} more` : ""}</span>}
    </button>)}{visible.length===0&&<p>No matching actions. Change any filter to recover.</p>}</div>
    <aside>{current ? <><h3>{current.id} · {current.title}</h3><p>{current.kind} · {current.plan} · P{current.priority} · {current.state}</p><p>Owner {current.owner.toLowerCase()}. Owner exit does not resolve this item.</p>
      <h4>All blocked nodes ({current.nodes.length})</h4>{current.nodes.map(n=><details key={n}><summary>{n}</summary><p>Plan: {current.plan} / Node: {n}</p><p>Waiting for {current.id}. Resolution releases this human dependency; other prerequisites still apply.</p></details>)}
      {current.kind==="Question" ? <><label>Inline answer<textarea aria-label="Inline answer" value={answer} onChange={e=>setAnswer(e.target.value)}/></label><button onClick={()=>answer.trim()?resolve("Answered",`Answered: ${answer}`):setError("An answer is required.")}>Send answer</button></> : current.id==="T1" ? <><h4>Explicit approval</h4><p>Board copy: Release readiness v2<br/>Board key: REL-42</p><label><input type="checkbox" checked={copy} onChange={e=>setCopy(e.target.checked)}/> I approve board copy “Release readiness v2”</label><label><input type="checkbox" checked={key} onChange={e=>setKey(e.target.checked)}/> I approve board key “REL-42”</label><button onClick={()=>copy&&key?resolve("Approved","Approved board copy Release readiness v2 / key REL-42"):setError("Explicit approval of both board copy and key is required.")}>Approve board copy and key</button></> : <button onClick={()=>resolve("Completed","Task completed")}>Complete task</button>}
      {error&&<p role="alert">{error}</p>}
      <label>Dismissal reason (required)<textarea aria-label="Dismissal reason" value={reason} onChange={e=>setReason(e.target.value)}/></label><button onClick={()=>reason.trim()?resolve("Dismissed",`Dismissed: ${reason}`):setError("A dismissal reason is required. Nothing was dismissed.")}>Dismiss with reason</button>
    </> : <><h3>Select an action</h3><p>Open its full blocked-node list, answer a question, complete a task, or dismiss with a reason.</p><p>Approval always names the board copy and key.</p></>}</aside></div>
  </section>;
}

export function HumanActionsTerminalMock() {
 const scene = new URLSearchParams(location.search).get("scene") ?? "list";
 const list = items.filter(i=>i.state==="Open").sort((a,b)=>Number(b.blocking)-Number(a.blocking)||a.priority-b.priority).map(i=>`${i.id}  ${i.kind.padEnd(8)} P${i.priority}  ${i.blocking?"BLOCKING   ":"nonblocking"} ${i.plan.padEnd(8)} scope:${i.scope.padEnd(4)} owner:${i.owner.toLowerCase()}  ${i.title}`).join("\n");
 const scenes: Record<string,string> = {
 list: `$ onepipeline human-items list\n${list}\n\n$ onepipeline human-items list --kind question --plan Release --state open --owner active --blocking true --priority 1 --scope plan\nQ1  Question P1 BLOCKING Release owner:active\nWhich release channel should we use?`,
 report: `$ onepipeline human-items report\nRelease  3 open / 2 tasks / 1 question / 2 blocking\nAccess   2 open / 1 task  / 1 question / 0 blocking\n\nQ1 blocks 5: publish-api, publish-ui, verify-install (+2 more)\nT1 blocks 3: publish-api, publish-ui, verify-install\nAccess nodes: rotate-key, verify-access, revoke-old-key\nT1, T2: owner ended; actions remain open\n\n$ onepipeline human-items show Q1\nQuestion / Release / Open / P1 / Blocking / Owner active\nWhich release channel should we use?\nAll blocked nodes:\n  publish-api\n  publish-ui\n  verify-install\n  announce-release\n  archive-evidence`,
 receipts: `$ onepipeline human-items answer Q1 --answer stable\nQ1 Answered: stable\n\n$ onepipeline human-items complete T2\nT2 Completed: Rotate staging credentials\n\n$ onepipeline human-items dismiss T3\nREFUSED: a dismissal reason is required. Nothing was dismissed.\n$ onepipeline human-items dismiss T3 --reason 'Superseded by release archive'\nT3 Dismissed: Superseded by release archive\n\n$ onepipeline human-items approve T1\nREFUSED: explicitly name both board copy and board key.\n$ onepipeline human-items approve T1 --board-copy 'Release readiness v2' --board-key REL-42\nT1 Approved: board copy Release readiness v2 / board key REL-42\n\nIllustrative receipts, each starting from the same open fixture.`,
 };
 return <main className="terminal-mock"><p className="mock-label">PROPOSED MOCK OUTPUT · commands not implemented · no engine evidence</p><h1>Human actions / {scene}</h1><pre>{scenes[scene] ?? scenes.list}</pre><p>Fixture only · the same Q1, Q2, T1–T4 as the browser mock</p></main>;
}
