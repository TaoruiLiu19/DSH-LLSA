export function agentForest(agents) {
  const nodes = new Map(agents.map(agent => [agent.id, { agent, children: [], parentKnown: true }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.agent.parentId);
    if (parent && parent !== node) parent.children.push(node);
    else {
      node.parentKnown = node.agent.parentId === null;
      roots.push(node);
    }
  }

  const placed = new Set();
  const markSubtree = (root) => {
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (placed.has(node)) continue;
      placed.add(node);
      stack.push(...node.children);
    }
  };
  roots.forEach(markSubtree);
  // A damaged cyclic relationship is displayed as unavailable, never as an infinite tree.
  for (const node of nodes.values()) {
    if (placed.has(node)) continue;
    const parent = nodes.get(node.agent.parentId);
    parent.children = parent.children.filter(child => child !== node);
    node.parentKnown = false;
    roots.push(node);
    markSubtree(node);
  }
  return roots;
}
