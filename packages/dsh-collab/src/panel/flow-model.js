/* Pure, browser-safe graph and counterfactual cost model. No model calls. */
const LeanLinkFlowModel = (() => {
    const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    function graph(data) {
        const nodes = new Map();
        for (const a of data.agents || []) {
            const id = a.id || a.agentId;
            if (id)
                nodes.set(id, { ...a, id });
        }
        for (const w of data.workItems || []) {
            if (w.parentId && !nodes.has(w.parentId))
                nodes.set(w.parentId, { id: w.parentId, role: 'coordinator', state: 'unknown' });
            if (w.childId)
                nodes.set(w.childId, { ...nodes.get(w.childId), id: w.childId, parentId: w.parentId, role: w.role || 'worker', state: w.state, objective: w.objective });
        }
        for (const e of data.events || [])
            if (e.kind === 'agent_relation' && e.payload?.provenance === 'host_superagent_lifecycle') {
                const p = e.payload;
                if (!p.parentId || !p.childId || p.parentId === p.childId)
                    continue;
                if (!nodes.has(p.parentId))
                    nodes.set(p.parentId, { id: p.parentId, role: 'coordinator', state: 'unknown' });
                nodes.set(p.childId, { ...nodes.get(p.childId), id: p.childId, parentId: p.parentId, role: 'worker' });
            }
        const edges = new Map();
        for (const n of nodes.values())
            if (n.parentId && nodes.has(n.parentId) && n.parentId !== n.id)
                edges.set(n.parentId + '→' + n.id, { id: n.parentId + '→' + n.id, from: n.parentId, to: n.id, kind: 'delegation', messages: [], measuredBefore: 0, measuredAfter: 0, measuredCount: 0, baselineDown: 0, baselineUp: 0 });
        for (const e of data.events || []) {
            const p = { ...e.payload };
            if (e.kind === 'delegation_input') {
                p.sender = nodes.get(p.recipient)?.parentId;
            }
            else if (['step_result', 'final_result'].includes(e.kind)) {
                p.sender = p.actorId;
                p.recipient = nodes.get(p.sender)?.parentId;
            }
            else if (e.kind !== 'agent_message')
                continue;
            if (!nodes.has(p.sender) || !nodes.has(p.recipient))
                continue;
            const key = edges.has(p.sender + '→' + p.recipient) ? p.sender + '→' + p.recipient : edges.has(p.recipient + '→' + p.sender) ? p.recipient + '→' + p.sender : p.sender + '→' + p.recipient;
            if (!edges.has(key))
                edges.set(key, { id: key, from: p.sender, to: p.recipient, kind: 'message', messages: [], measuredBefore: 0, measuredAfter: 0, measuredCount: 0, baselineDown: 0, baselineUp: 0 });
            const edge = edges.get(key);
            edge.messages.push({ ...e, payload: p });
            const m = p.selected?.metrics;
            if (finite(m?.baselineTokens) && finite(m?.selectedTokens)) {
                edge.measuredBefore += m.baselineTokens;
                edge.measuredAfter += m.selectedTokens;
                edge.measuredCount++;
                edge[p.sender === edge.from ? "baselineDown" : "baselineUp"] += m.baselineTokens;
            }
        }
        return { nodes: [...nodes.values()], edges: [...edges.values()] };
    }
    function estimate(p) {
        for (const k of ['down', 'up', 'ratio', 'overhead', 'reuse', 'hitBefore', 'hitAfter', 'missPrice', 'hitPrice', 'outputPrice', 'generated'])
            if (!finite(p[k]))
                return null;
        if (p.ratio > 1 || p.hitBefore > 1 || p.hitAfter > 1 || p.generated > 1 || p.reuse < 1)
            return null;
        const base = p.down + p.up, compact = base * (1 - p.ratio);
        const beforeInput = base * p.reuse, afterInput = (compact + p.overhead) * p.reuse;
        const beforeOutput = base * p.generated, afterOutput = compact * p.generated;
        const cost = (input, output, hit) => (input * (hit * p.hitPrice + (1 - hit) * p.missPrice) + output * p.outputPrice) / 1e6;
        const before = cost(beforeInput, beforeOutput, p.hitBefore), after = cost(afterInput, afterOutput, p.hitAfter);
        const result = { before, after, saved: before - after, tokensSaved: beforeInput + beforeOutput - afterInput - afterOutput, wireSaved: base - compact, beforeTokens: beforeInput + beforeOutput, afterTokens: afterInput + afterOutput };
        return Object.values(result).every(Number.isFinite) ? result : null;
    }
    function layout(nodes) {
        const map=new Map(nodes.map(n=>[n.id,n])),children=new Map(nodes.map(n=>[n.id,[]]));
        for(const n of nodes)if(n.parentId!==n.id&&map.has(n.parentId))children.get(n.parentId).push(n.id);
        const positions=new Map(),visited=new Set();let cursor=0,maxDepth=0;
        function place(id,depth){
            if(visited.has(id))return null;
            visited.add(id);maxDepth=Math.max(maxDepth,depth);
            const childXs=children.get(id).map(child=>place(child,depth+1)).filter(x=>x!==null);
            const x=childXs.length?(childXs[0]+childXs.at(-1))/2:cursor++*228;
            positions.set(id,{x,y:depth*170+40});return x;
        }
        for(const n of nodes)if(!map.has(n.parentId)||n.parentId===n.id)place(n.id,0);
        // Malformed cycles stay inspectable without infinite recursion or fabricated links.
        for(const n of nodes)if(!visited.has(n.id))place(n.id,0);
        const width=Math.max(800,cursor*228+60),offset=(width-cursor*228)/2+14;
        return {width,height:Math.max(360,(maxDepth+1)*170+80),nodes:nodes.map(n=>({...n,...positions.get(n.id),x:positions.get(n.id).x+offset}))};
    }
    return { graph, estimate, layout };
})();
