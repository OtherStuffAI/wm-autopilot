import {
  BaseImage,
  Link,
  Placeholder,
  StarterKit,
  TaskItem,
  TaskList,
} from "/vendor/tiptap-bundle.js";

export const MarkdownImage = BaseImage.extend({
  name: "image",
  addAttributes() {
    return {
      ...this.parent?.(),
      rawSrc: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-raw-src"),
        renderHTML: (attributes) => (
          attributes.rawSrc ? { "data-raw-src": attributes.rawSrc } : {}
        ),
      },
    };
  },
});

export function createAutopilotTiptapExtensions(options = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
    }),
    Placeholder.configure({
      placeholder: options.placeholder || "Start writing...",
    }),
    MarkdownImage.configure({
      inline: false,
      allowBase64: false,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ];
}
