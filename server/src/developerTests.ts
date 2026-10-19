import * as ts from 'typescript';

/** A conservative syntax check, not a proof of assertion quality or test-first ordering. */
export function validateDeveloperTests(file: string, source: string, baseline: string): void {
  const parse = (text: string) =>
    ts.createSourceFile(file, text.replaceAll('\r\n', '\n'), ts.ScriptTarget.Latest, true);
  const declarations = (root: ts.SourceFile) => {
    const found: { node: ts.CallExpression; kind: string; modifiers: string[] }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        let target: ts.Expression = node.expression;
        const modifiers: string[] = [];
        while (
          ts.isPropertyAccessExpression(target) ||
          ts.isElementAccessExpression(target) ||
          ts.isCallExpression(target)
        ) {
          if (ts.isPropertyAccessExpression(target)) {
            modifiers.push(target.name.text);
            target = target.expression;
          } else if (ts.isElementAccessExpression(target)) {
            if (ts.isStringLiteral(target.argumentExpression))
              modifiers.push(target.argumentExpression.text);
            target = target.expression;
          } else target = target.expression;
        }
        if (ts.isIdentifier(target) && ['it', 'test', 'describe', 'suite'].includes(target.text))
          found.push({ node, kind: target.text, modifiers });
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
    return found;
  };
  const previous = new Map<string, number>();
  for (const { node } of declarations(parse(baseline)))
    previous.set(node.getText(), (previous.get(node.getText()) ?? 0) + 1);
  for (const { node, kind, modifiers } of declarations(parse(source))) {
    const text = node.getText();
    const count = previous.get(text) ?? 0;
    if (count) {
      previous.set(text, count - 1);
      continue;
    }
    const disabledOptions = node.arguments.some(
      (arg) =>
        ts.isObjectLiteralExpression(arg) &&
        arg.properties.some(
          (prop) =>
            ts.isPropertyAssignment(prop) &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
            ['skip', 'todo', 'only'].includes(prop.name.text) &&
            prop.initializer.kind !== ts.SyntaxKind.FalseKeyword,
        ),
    );
    if (
      disabledOptions ||
      modifiers.some((modifier) => ['skip', 'todo', 'only', 'skipIf', 'runIf'].includes(modifier))
    )
      throw new Error(`Developer test contains skip/todo/only: ${file}`);
    // Intermediate parameterization calls do not declare a test callback themselves.
    if (
      !['it', 'test'].includes(kind) ||
      (['each', 'for'].some((modifier) => modifiers.includes(modifier)) &&
        node.arguments.length < 2)
    )
      continue;
    const callback = node.arguments.find(
      (arg): arg is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(arg) || ts.isFunctionExpression(arg),
    );
    let assertion = false;
    const visit = (child: ts.Node): void => {
      if (ts.isCallExpression(child)) {
        const target = child.expression;
        if (
          (ts.isIdentifier(target) && ['expect', 'assert'].includes(target.text)) ||
          (ts.isPropertyAccessExpression(target) &&
            ts.isIdentifier(target.expression) &&
            target.expression.text === 'assert')
        )
          assertion = true;
      }
      ts.forEachChild(child, visit);
    };
    if (callback) visit(callback.body);
    if (!assertion)
      throw new Error(`Developer test requires an assertion in each new test body: ${file}`);
  }
}
