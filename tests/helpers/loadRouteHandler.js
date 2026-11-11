import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

export function loadRouteHandler(routeUrl, handler, dependencies) {
  const source = ts.createSourceFile(
    "route.jsx",
    fs.readFileSync(routeUrl, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JSX,
  );
  const declaration = source.statements.find(
    (node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === handler) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (entry) => entry.name.getText(source) === handler,
        )),
  );
  assert.ok(declaration, handler);
  const transformed = ts.transform(
    ts.factory.updateSourceFile(source, [declaration]),
    [
      (context) => (root) => {
        const visit = (node) => {
          if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
          ) {
            return ts.factory.updateCallExpression(
              node,
              ts.factory.createIdentifier("loadModule"),
              node.typeArguments,
              node.arguments,
            );
          }
          return ts.visitEachChild(node, visit, context);
        };
        return ts.visitNode(root, visit);
      },
    ],
  );
  const printed = ts.createPrinter().printFile(transformed.transformed[0]);
  transformed.dispose();
  const code = ts.transpileModule(printed, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exported = {};
  new Function("exports", ...Object.keys(dependencies), code)(
    exported,
    ...Object.values(dependencies),
  );
  return exported[handler];
}
