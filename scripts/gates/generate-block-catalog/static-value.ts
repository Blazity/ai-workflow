import ts from "typescript";
import { objectProperty, propertyName, unwrap } from "./manifest-ast.js";
import type { StaticValue } from "./types.js";

export function localDeclarations(file: ts.SourceFile): Map<string, ts.Expression> {
  const declarations = new Map<string, ts.Expression>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        declarations.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return declarations;
}

function staticArrayValue(
  value: ts.ArrayLiteralExpression,
  filePath: string,
  declarations: ReadonlyMap<string, ts.Expression>,
  resolving: ReadonlySet<string>,
): StaticValue[] {
  return value.elements.map((element, index) => {
    if (ts.isSpreadElement(element)) {
      throw new Error(filePath + ": metadata arrays cannot contain spreads at index " + index + ".");
    }
    return staticValue(element, filePath, declarations, resolving);
  });
}

function staticObjectValue(
  value: ts.ObjectLiteralExpression,
  filePath: string,
  declarations: ReadonlyMap<string, ts.Expression>,
  resolving: ReadonlySet<string>,
): { [key: string]: StaticValue } {
  const result: { [key: string]: StaticValue } = {};
  for (const property of value.properties) {
    if (ts.isSpreadAssignment(property)) {
      throw new Error(filePath + ": metadata objects cannot contain spread properties.");
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      result[property.name.text] = staticValue(
        property.name,
        filePath,
        declarations,
        resolving,
      );
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(filePath + ": metadata objects may contain only data properties.");
    }
    const name = propertyName(property.name);
    if (name === null) {
      throw new Error(filePath + ": metadata property names must be identifiers or strings.");
    }
    result[name] = staticValue(property.initializer, filePath, declarations, resolving);
  }
  return result;
}

function staticIdentifierValue(
  value: ts.Identifier,
  filePath: string,
  declarations: ReadonlyMap<string, ts.Expression>,
  resolving: ReadonlySet<string>,
): StaticValue {
  const initializer = declarations.get(value.text);
  if (!initializer) {
    throw new Error(filePath + ": metadata references unknown value \"" + value.text + "\".");
  }
  if (resolving.has(value.text)) {
    throw new Error(filePath + ": metadata contains a circular value reference.");
  }
  return staticValue(initializer, filePath, declarations, new Set([...resolving, value.text]));
}

function staticValue(
  expression: ts.Expression,
  filePath: string,
  declarations: ReadonlyMap<string, ts.Expression>,
  resolving: ReadonlySet<string> = new Set(),
): StaticValue {
  const value = unwrap(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isNumericLiteral(value)) {
    const number = Number(value.text.replaceAll("_", ""));
    if (Number.isFinite(number)) return number;
  }
  if (
    ts.isPrefixUnaryExpression(value) &&
    (value.operator === ts.SyntaxKind.MinusToken || value.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(value.operand)
  ) {
    const number = Number(value.operand.text.replaceAll("_", ""));
    if (Number.isFinite(number)) {
      return value.operator === ts.SyntaxKind.MinusToken ? -number : number;
    }
  }
  if (ts.isIdentifier(value)) return staticIdentifierValue(value, filePath, declarations, resolving);
  if (ts.isArrayLiteralExpression(value)) {
    return staticArrayValue(value, filePath, declarations, resolving);
  }
  if (ts.isObjectLiteralExpression(value)) {
    return staticObjectValue(value, filePath, declarations, resolving);
  }
  throw new Error(filePath + ": metadata must be made of literal data values.");
}

export function requiredStaticValue(
  manifest: ts.ObjectLiteralExpression,
  name: string,
  filePath: string,
  declarations: ReadonlyMap<string, ts.Expression>,
): StaticValue {
  const expression = objectProperty(manifest, name);
  if (!expression) throw new Error(filePath + ": manifest." + name + " is required.");
  return staticValue(expression, filePath, declarations);
}
