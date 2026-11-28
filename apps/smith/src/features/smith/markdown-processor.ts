/**
 * Markdown to React elements, as react-markdown's `Markdown` does, with the
 * same plugins and options, but with processors that are made one time.
 * `Markdown` makes a new unified processor (and sets up each plugin again) on
 * each render, and a streaming reply renders many times a second.
 *
 * Text without `<` has no raw HTML, so it skips `rehype-raw`, which parses
 * the whole tree again with parse5. The output stays the same
 * (`markdown-processor.test.tsx`).
 */
import type { Element, Root, RootContent, Text } from "hast"
import { toJsxRuntime, type Components } from "hast-util-to-jsx-runtime"
import { urlAttributes } from "html-url-attributes"
import type { ReactElement } from "react"
import { Fragment, jsx, jsxs } from "react/jsx-runtime"
import { defaultUrlTransform, type UrlTransform } from "react-markdown"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { type Options as SanitizeSchema } from "rehype-sanitize"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified, type PluggableList } from "unified"
import { visit } from "unist-util-visit"
import { VFile } from "vfile"

type MarkdownOptions = {
  /** Keep each line break (remark-breaks), as in user text. */
  breaks: boolean
  components?: Components
  /** Parse raw HTML (rehype-raw). Off: raw HTML shows as text. */
  raw?: boolean
  sanitizeSchema: SanitizeSchema
  urlTransform?: UrlTransform
}

function createProcessor(
  breaks: boolean,
  raw: boolean,
  sanitizeSchema: SanitizeSchema
) {
  // The same plugins, in the same order, as react-markdown with
  // MARKDOWN_REMARK_PLUGINS and MARKDOWN_REHYPE_PLUGINS.
  const rehypePlugins: PluggableList = raw
    ? [rehypeRaw, [rehypeSanitize, sanitizeSchema]]
    : [[rehypeSanitize, sanitizeSchema]]
  return unified()
    .use(remarkParse)
    .use(breaks ? [remarkGfm, remarkBreaks] : [remarkGfm])
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypePlugins)
    .freeze()
}

type Processor = ReturnType<typeof createProcessor>

const processors = new WeakMap<SanitizeSchema, Map<string, Processor>>()

function processorFor(
  breaks: boolean,
  raw: boolean,
  sanitizeSchema: SanitizeSchema
) {
  let bySchema = processors.get(sanitizeSchema)
  if (!bySchema) {
    bySchema = new Map()
    processors.set(sanitizeSchema, bySchema)
  }
  const key = `${breaks}:${raw}`
  let processor = bySchema.get(key)
  if (!processor) {
    processor = createProcessor(breaks, raw, sanitizeSchema)
    bySchema.set(key, processor)
  }
  return processor
}

/** True when the text can hold raw HTML. */
export function markdownMayHaveHtml(text: string) {
  return text.includes("<")
}

const TABLE_PARTS = new Set(["table", "thead", "tbody", "tfoot", "tr"])

function isWhitespaceText(node: RootContent): node is Text {
  return node.type === "text" && node.value.trim() === ""
}

/**
 * Make a tree that did not go through rehype-raw the same as one that did.
 * rehype-raw parses the tree again as HTML (parse5), which changes two
 * things: a data attribute without a value (`data-footnotes`) becomes ""
 * (React writes `true` otherwise), and the line breaks between the parts of a
 * table move before the table (HTML "foster parenting").
 */
function asIfParsedAsHtml(tree: Root) {
  visit(tree, "element", (node, index, parent) => {
    for (const key of Object.keys(node.properties))
      if (key.startsWith("data") && node.properties[key] === true)
        node.properties[key] = ""
    if (node.tagName !== "table" || !parent || typeof index !== "number")
      return undefined
    const moved: Text[] = []
    const collect = (part: Element) => {
      part.children = part.children.filter((child) => {
        if (isWhitespaceText(child)) {
          moved.push(child)
          return false
        }
        if (child.type === "element" && TABLE_PARTS.has(child.tagName))
          collect(child)
        return true
      })
    }
    collect(node)
    if (!moved.length) return undefined
    parent.children.splice(index, 0, ...moved)
    // Visit the table again at its new index.
    return index + moved.length
  })
}

/** Render markdown to React elements (react-markdown's `Markdown`). */
export function renderMarkdown(
  text: string,
  {
    breaks,
    components,
    raw = markdownMayHaveHtml(text),
    sanitizeSchema,
    urlTransform = defaultUrlTransform,
  }: MarkdownOptions
): ReactElement {
  const processor = processorFor(breaks, raw, sanitizeSchema)
  const file = new VFile()
  file.value = text
  const tree = processor.runSync(processor.parse(file), file)
  if (!raw) asIfParsedAsHtml(tree)

  // As react-markdown's `post`: raw HTML that is left shows as text, and
  // URLs go through `urlTransform`.
  visit(tree, (node, index, parent) => {
    if (node.type === "raw" && parent && typeof index === "number") {
      parent.children[index] = { type: "text", value: node.value }
      return index
    }
    if (node.type === "element") {
      for (const key in urlAttributes) {
        if (
          Object.hasOwn(urlAttributes, key) &&
          Object.hasOwn(node.properties, key)
        ) {
          const test = urlAttributes[key]
          if (test === null || test.includes(node.tagName)) {
            node.properties[key] = urlTransform(
              String(node.properties[key] || ""),
              key,
              node
            )
          }
        }
      }
    }
    return undefined
  })

  return toJsxRuntime(tree, {
    Fragment,
    components,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  })
}
