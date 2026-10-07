/** Keep message DOM (including decoded images) across identical reactive updates. */
export function registerMessageHtmlDirective(Alpine) {
  Alpine.directive("message-html", (element, { expression }, { effect, evaluateLater }) => {
    const evaluate = evaluateLater(expression);
    let renderedHtml;

    effect(() => {
      evaluate((value) => {
        const html = value ?? "";
        if (html === renderedHtml) return;

        Alpine.mutateDom(() => {
          for (const child of element.children) {
            Alpine.destroyTree(child);
          }
          element.innerHTML = html;
          element._x_ignoreSelf = true;
          try {
            Alpine.initTree(element);
          } finally {
            delete element._x_ignoreSelf;
          }
        });
        renderedHtml = html;
      });
    });
  });
}
