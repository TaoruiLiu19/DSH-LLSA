/* Genealogy view uses only recorded relationships; slider changes are simulations. */
const LeanLinkFlow = (() => {
    let data = null, model = { nodes: [], edges: [] }, selected = null, demo = false;
    const settings = new Map(), el = id => document.getElementById(id);
    const labels = { coordinator: '主协调 Agent', root: '主 Agent', worker: '执行 Agent', researcher: '研究 Agent', reviewer: '审核 Agent', implementer: '开发 Agent', tester: '测试 Agent' };
    const num = id => { const v = el(id).value.trim(); return v === '' ? NaN : Number(v); };
    function node(tag, cls, text) { const n = document.createElement(tag); if (cls)
        n.className = cls; if (text !== undefined)
        n.textContent = text; return n; }
    function svg(tag, attrs) { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs))
        n.setAttribute(k, String(v)); return n; }
    const money = n => (n < 0 ? '−' : '') + '$' + Math.abs(n).toFixed(6);
    const count = n => Math.round(n).toLocaleString('zh-CN');
    function params(edge) { const s = settings.get(edge.id) || {}; return { down: s.down ?? (demo ? 2400 : edge.measuredCount ? edge.baselineDown : NaN), up: s.up ?? (demo ? 900 : edge.measuredCount ? edge.baselineUp : NaN), ratio: s.ratio ?? num('flow-strength') / 100, overhead: num('flow-overhead'), reuse: num('flow-reuse'), hitBefore: num('flow-hit-before') / 100, hitAfter: num('flow-hit-after') / 100, generated: el('flow-generated').checked ? 1 : 0, missPrice: s.missPrice ?? num('flow-miss-price'), hitPrice: s.hitPrice ?? num('flow-hit-price'), outputPrice: s.outputPrice ?? num('flow-output-price') }; }
    function stats() {
        let before = 0, after = 0, saved = 0, tokens = 0, known = 0;
        for (const edge of model.edges) {
            const p = params(edge), r = LeanLinkFlowModel.estimate(p);
            if (!r)
                continue;
            known++;
            before += r.before;
            after += r.after;
            saved += r.saved;
            tokens += r.tokensSaved;
        }
        el('flow-tokens').textContent = known ? count(tokens) : '待补充';
        el('flow-money').textContent = known ? money(saved) : '待补充';
        el('flow-money').classList.toggle('flow-negative', saved < 0);
        el('flow-money-label').textContent=saved<0?'预计净变化 · 增费（USD）':'预计净节省费用 · USD';
        el('flow-coverage-note').textContent=known<model.edges.length?'仅已知连接小计，不能代表整个任务':'仅本图通信情景，不含未建模调用与重试';
        el('flow-tokens').classList.toggle('flow-negative', tokens < 0);
        el('flow-coverage').textContent = known + ' / ' + model.edges.length + ' 条连接';
        el('flow-before-after').textContent = known ? money(before) + ' → ' + money(after) : '填写原始通信 token 后计算';
        el('flow-strength-value').textContent = el('flow-strength').value + '%';
        const edge = model.edges.find(e => e.id === selected);
        if (edge) {
            const p = params(edge), r = LeanLinkFlowModel.estimate(p), overrides = settings.get(edge.id) || {};
            if (!Object.hasOwn(overrides, 'ratio')) el('flow-edge-strength').value = p.ratio * 100;
            for (const [id, key] of [['flow-down','down'],['flow-up','up'],['flow-edge-miss','missPrice'],['flow-edge-hit','hitPrice'],['flow-edge-output','outputPrice']]) {
                if (!Object.hasOwn(overrides,key)) el(id).value = Number.isFinite(p[key]) ? p[key] : '';
            }
            el('flow-edge-strength-label').textContent = Math.round(p.ratio * 100) + '%';
            el('flow-edge-estimate').textContent = r ? '该连接预计 ' + (r.saved >= 0 ? '节省 ' : '增加 ') + money(Math.abs(r.saved)) + ' · token 净变化 ' + count(r.tokensSaved) : '缺少原始通信 token，暂不估算。';
        }
    }
    function choose(id) {
        selected = id;
        const e = model.edges.find(e => e.id === id);
        if (!e)
            return;
        el('flow-edge-controls').hidden = false;
        el('flow-selection').textContent = (labels[model.nodes.find(n => n.id === e.from)?.role] || 'Agent') + ' → ' + (labels[model.nodes.find(n => n.id === e.to)?.role] || 'Agent');
        el('flow-selection').title=e.from+' → '+e.to;
        const p = params(e);
        for (const [field, key] of [['flow-down', 'down'], ['flow-up', 'up'], ['flow-edge-miss', 'missPrice'], ['flow-edge-hit', 'hitPrice'], ['flow-edge-output', 'outputPrice']])
            el(field).value = Number.isFinite(p[key]) ? p[key] : '';
        el('flow-edge-strength').value = p.ratio * 100;
        el('flow-observed').textContent = e.measuredCount ? e.measuredCount + ' / '+e.messages.length+' 条消息有本地编码计数：' + count(e.measuredBefore) + ' → ' + count(e.measuredAfter) + ' token；仅对这些已计数消息估算，不是全任务 API 节省。' : '此连接没有完整编码前后计数，不能据此认定实际节省。';
        const target = el('flow-records');
        target.replaceChildren();
        for (const event of e.messages.slice(-20).reverse()) {
            const b = node('button', 'flow-record', String(event.runSeq ?? event.seq ?? '') + ' · ' + event.payload.sender + ' → ' + event.payload.recipient);
            b.type = 'button';
            b.addEventListener('click', () => { el('step-id').value = event.stepId || ''; el('attempt-id').value = event.attemptId || ''; el('as-of').value = event.runSeq ?? event.seq ?? ''; el('inspect').click(); el('chinese').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
            target.append(b);
        }
        if (!e.messages.length)
            target.append(node('p', 'note', demo ? '演示连接，没有真实步骤记录。' : '尚无显式消息记录；调用与回传仅表示关系方向。'));
        draw();
        stats();
    }
    function draw() {
        const canvas = el('flow-canvas');
        canvas.replaceChildren();
        const layout = LeanLinkFlowModel.layout(model.nodes);
        canvas.style.width = layout.width + 'px';
        canvas.style.height = layout.height + 'px';
        canvas.style.zoom = String(Math.min(1, Math.max(.45, canvas.parentElement.clientWidth / layout.width)));
        const surface = svg('svg', { width: layout.width, height: layout.height, 'aria-hidden': 'true' });
        const defs = svg('defs', {});
        for (const [id, color] of [['flow-down-arrow', '#7568eb'], ['flow-up-arrow', '#21aa96']]) {
            const m = svg('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
            m.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
            defs.append(m);
        }
        surface.append(defs);
        canvas.append(surface);
        const positions = new Map(layout.nodes.map(n => [n.id, n]));
        for (const edge of model.edges) {
            const a = positions.get(edge.from), b = positions.get(edge.to);
            if (!a || !b)
                continue;
            const x1 = a.x + 100, y1 = a.y + 90, x2 = b.x + 100, y2 = b.y;
            const bend = (y1 + y2) / 2;
            surface.append(svg('path', { d: `M ${x1 - 6} ${y1} C ${x1 - 6} ${bend} ${x2 - 6} ${bend} ${x2 - 6} ${y2}`, fill: 'none', stroke: '#7568eb', 'stroke-width': selected === edge.id ? 3 : 1.7, 'marker-end': 'url(#flow-down-arrow)', 'stroke-dasharray': edge.kind === 'message' ? '5 4' : 'none' }));
            surface.append(svg('path', { d: `M ${x2 + 6} ${y2} C ${x2 + 6} ${bend} ${x1 + 6} ${bend} ${x1 + 6} ${y1}`, fill: 'none', stroke: '#21aa96', 'stroke-width': 1.5, 'marker-end': 'url(#flow-up-arrow)' }));
            const badge = node('button', 'flow-edge' + (selected === edge.id ? ' selected' : ''), '预测 '+Math.round(params(edge).ratio * 100) + '% · ' + (demo?'演示连接':edge.messages.length + ' 条消息'));
            badge.type = 'button';
            badge.style.left = (x2 - 58) + 'px';
            badge.style.top = (y2 - 42) + 'px';
            badge.addEventListener('click', () => choose(edge.id));
            canvas.append(badge);
        }
        for (const n of layout.nodes) {
            const card = node('button', 'flow-agent');
            card.type = 'button';
            card.style.left = n.x + 'px';
            card.style.top = n.y + 'px';
            card.append(node('span', 'flow-agent-role', labels[n.role] || n.role || 'Agent'), node('strong', '', n.name || n.objective?.slice(0, 22) || n.id.slice(0, 22)), node('span', 'flow-agent-state', typeof stateLabel === 'function' ? stateLabel(n.state) : n.state || '未知'));
            card.title = n.id;
            card.dataset.state=n.state||'unknown';
            card.addEventListener('click', () => { const edge = model.edges.find(e => e.to === n.id) || model.edges.find(e => e.from === n.id); if (edge)
                choose(edge.id);
            else
                el('flow-selection').textContent = n.id + ' · 暂无父子连接'; });
            canvas.append(card);
        }
        if (!model.nodes.length)
            canvas.append(node('p', 'flow-empty', '选择任务后展示真实调用关系，或点击「查看演示」。'));
    }
    function render(value, isDemo = false) { if (data?.run?.id !== value?.run?.id || demo !== isDemo) {
        settings.clear();
        selected = null;
    } data = value; demo = isDemo; model = LeanLinkFlowModel.graph(value || {}); el('flow-mode').textContent = demo ? '演示数据 · 无 API 调用' : '真实记录 · 情景估算'; el('flow-edge-controls').hidden = !selected; el('flow-selection').textContent = selected ? el('flow-selection').textContent : '点击连接，调整这条通信的压缩比例'; draw(); stats(); }
    function init() {
        for (const id of ['flow-strength', 'flow-overhead', 'flow-reuse', 'flow-hit-before', 'flow-hit-after', 'flow-generated', 'flow-miss-price', 'flow-hit-price', 'flow-output-price'])
            el(id).addEventListener('input', () => { draw(); stats(); });
        for (const [id, key] of [['flow-down', 'down'], ['flow-up', 'up'], ['flow-edge-strength', 'ratio'], ['flow-edge-miss', 'missPrice'], ['flow-edge-hit', 'hitPrice'], ['flow-edge-output', 'outputPrice']])
            el(id).addEventListener('input', () => { if (!selected)
                return; settings.set(selected, { ...settings.get(selected), [key]: key === 'ratio' ? num(id) / 100 : num(id) }); draw(); stats(); });
        el('flow-reset-edge').addEventListener('click', () => { if (selected) {
            settings.delete(selected);
            choose(selected);
        } });
        el('flow-demo').addEventListener('click', () => render({ run: { id: 'demo' }, agents: [{ id: 'coordinator', role: 'coordinator', name: '任务规划与验收', state: 'running' }, { id: 'research', parentId: 'coordinator', role: 'researcher', name: '资料核对', state: 'succeeded' }, { id: 'build', parentId: 'coordinator', role: 'implementer', name: '实现与交付', state: 'running' }, { id: 'review', parentId: 'coordinator', role: 'reviewer', name: '独立审核', state: 'submitted' }, { id: 'test', parentId: 'build', role: 'tester', name: '测试与证据', state: 'running' }], events: [] }, true));
        window.addEventListener('resize', () => draw());
        el('flow-live').addEventListener('click', () => { if (typeof loadRun === 'function' && current)
            loadRun();
        else
            render({}); });
        render({});
    }
    return { init, render };
})();
