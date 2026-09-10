import { readFileSync } from "node:fs";
import ts from "typescript";
import type { ManifestRecord } from "./types.js";

export function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

export function propertyName(property: ts.PropertyName): string | null {
  if (ts.isIdentifier(property) || ts.isStringLiteral(property)) return property.text;
  return null;
}

export function unwrap(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
}

export function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
      propertyName(candidate.name) === name,
  );
  if (!property) return undefined;
  return ts.isPropertyAssignment(property) ? property.initializer : property.name;
}

export function objectValue(
  expression: ts.Expression | undefined,
  filePath: string,
  property: string,
): ts.ObjectLiteralExpression {
  const value = expression && unwrap(expression);
  if (!value || !ts.isObjectLiteralExpression(value)) {
    throw new Error(filePath + ": manifest." + property + " must be an object literal.");
  }
  return value;
}

export function stringValue(
  expression: ts.Expression | undefined,
  filePath: string,
  property: string,
): string {
  const value = expression && unwrap(expression);
  if (!value || !ts.isStringLiteral(value)) {
    throw new Error(filePath + ": manifest." + property + " must be a string literal.");
  }
  return value.text;
}

export function booleanValue(
  expression: ts.Expression | undefined,
  filePath: string,
  property: string,
): boolean {
  const value = expression && unwrap(expression);
  if (
    !value ||
    (value.kind !== ts.SyntaxKind.TrueKeyword && value.kind !== ts.SyntaxKind.FalseKeyword)
  ) {
    throw new Error(filePath + ": manifest." + property + " must be a boolean literal.");
  }
  return value.kind === ts.SyntaxKind.TrueKeyword;
}

export function stringArrayValue(
  expression: ts.Expression | undefined,
  filePath: string,
  property: string,
): string[] {
  const value = expression && unwrap(expression);
  if (!value || !ts.isArrayLiteralExpression(value)) {
    throw new Error(filePath + ": manifest." + property + " must be an array literal.");
  }
  return value.elements.map((element, index) => {
    if (!ts.isStringLiteral(element)) {
      throw new Error(
        filePath + ": manifest." + property + "[" + index + "] must be a string literal.",
      );
    }
    return element.text;
  });
}

export function uiValue(
  expression: ts.Expression | undefined,
  filePath: string,
): ManifestRecord["ui"] {
  const ui = objectValue(expression, filePath, "ui");
  return {
    group: stringValue(objectProperty(ui, "group"), filePath, "ui.group"),
    label: stringValue(objectProperty(ui, "label"), filePath, "ui.label"),
    description: stringValue(
      objectProperty(ui, "description"),
      filePath,
      "ui.description",
    ),
    glyph: stringValue(objectProperty(ui, "glyph"), filePath, "ui.glyph"),
    color: stringValue(objectProperty(ui, "color"), filePath, "ui.color"),
    softColor: stringValue(objectProperty(ui, "softColor"), filePath, "ui.softColor"),
  };
}

export function exportedVariable(
  file: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | undefined {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!exported) continue;
    const declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
    );
    if (declaration) return declaration;
  }
  return undefined;
}
