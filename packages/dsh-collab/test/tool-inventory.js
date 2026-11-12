import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {RUN_CODE_NAME} from '@deepseek-ai/dsh-tools';

/** Discover producer declarations, independently of the alias table. Unknown computed IDs fail closed. */
export function emittedToolIds() {
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const files=[join(root,'packages/dsh-collab/src/index.js')];
  const tools=join(root,'packages/superagent/src/app/tools');
  files.push(...readdirSync(tools).filter(f=>f.endsWith('.ts')).map(f=>join(tools,f)));
  const host=join(root,'node_modules/@deepseek-ai');
  files.push(...readdirSync(host).filter(f=>f.startsWith('dsh-tool-')).map(f=>join(host,f,'lib/index.js')));
  const ids=new Set();
  for (const file of files) {
    const source=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
    const declarations=new Map();
    const imported=new Map();
    for(const statement of source.statements) if(ts.isImportDeclaration(statement)&&statement.moduleSpecifier.text==='@deepseek-ai/dsh-tools')
      for(const specifier of statement.importClause?.namedBindings?.elements??[])
        if((specifier.propertyName??specifier.name).text==='RUN_CODE_NAME') imported.set(specifier.name.text,RUN_CODE_NAME);
    const walk=(node,visit)=>{visit(node);ts.forEachChild(node,child=>walk(child,visit));};
    walk(source,node=>{
      if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer) declarations.set(node.name.text,node.initializer);
      if(ts.isPropertyAssignment(node)&&node.name.getText(source)==='toolName'&&ts.isCallExpression(node.initializer)
        &&node.initializer.expression.getText(source).endsWith('.default')) declarations.set('toolName',node.initializer.arguments[0]);
    });
    const literal=node=>{
      if(ts.isStringLiteralLike(node)) return node.text;
      if(ts.isIdentifier(node)&&imported.has(node.text)) return imported.get(node.text);
      if(ts.isIdentifier(node)&&declarations.has(node.text)) return literal(declarations.get(node.text));
      if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken) return literal(node.right);
      throw new Error(`Review computed tool ID in ${file}: ${node.getText(source)}`);
    };
    walk(source,node=>{
      if(!ts.isCallExpression(node)) return;
      const callee=node.expression.getText(source),arg=node.arguments[0];
      if(['defineTool','tool'].includes(callee)&&arg&&ts.isObjectLiteralExpression(arg)) {
        const name=arg.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)==='name');
        if(name) ids.add(literal(name.initializer));
      }
      if(callee==='register'&&arg&&ts.isStringLiteral(arg)) ids.add(arg.text);
    });
  }
  return [...ids].sort();
}
