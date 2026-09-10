import ts from "typescript";

function isAllowedImport(specifier: string): boolean {
  return specifier === "zod" || specifier === "@shared/contracts";
}

export function assertPureImports(filePath: string, file: ts.SourceFile): void {
  const check = (specifier: string) => {
    if (isAllowedImport(specifier)) return;
    const normalized = specifier.replaceAll("\\", "/");
    const runtimePath =
      /(?:^|\/)(?:sandbox|lib|db|adapters|workflows)(?:\/|$)/u.test(normalized) ||
      /(?:^|\/)agent-workflow(?:\.js)?$/u.test(normalized) ||
      /(?:^|\/)engine\/blocks\/[^/]+\/execute(?:\.js)?$/u.test(normalized);
    const reason = runtimePath ? "forbidden runtime import" : "unsupported import";
    throw new Error(filePath + ": " + reason + " \"" + specifier + "\".");
  };

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (
        statement.moduleSpecifier.text === "@shared/contracts" &&
        !statement.importClause?.isTypeOnly
      ) {
        throw new Error(
          filePath + ": contract imports must be type-only \"@shared/contracts\".",
        );
      }
      check(statement.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      check(statement.moduleSpecifier.text);
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      check(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
