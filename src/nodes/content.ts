// Helpers for adapters: the text of a message, and images given by URL turned into what they stand for.
import type { MaybePromise } from "../index.js";
import type { ChatMessage, ContentPart, ImagePart, MessageContent } from "./llm.js";
import { andThen } from "./util.js";

export interface TextOfOptions {
  /** Written in place of each image. Without it, an image is an error. */
  readonly imagePlaceholder?: string;
}

/** The text of a message's content, for adapters that send text only. Images are an error unless replaced. */
export function textOf(content: MessageContent, options: TextOfOptions = {}): string {
  if (typeof content === "string") return content;
  let text = "";
  for (const part of content) {
    if (part.type === "text") text += part.text;
    else if (options.imagePlaceholder !== undefined) text += options.imagePlaceholder;
    else {
      throw new TypeError(
        "textOf: the content has images and this adapter sends text only; pass { imagePlaceholder } to replace them",
      );
    }
  }
  return text;
}

/** Reads an image URL an adapter cannot send as it is, e.g. `media:abc` from your own store. */
export type ImageResolver = (url: string) => MaybePromise<ImagePart>;

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/i;

const shown = (url: string): string => (url.length > 100 ? `${url.slice(0, 100)}…` : url);

const isURLImage = (part: ContentPart): boolean => part.type === "image" && !("data" in part);

function isImagePart(value: unknown): value is ImagePart {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "image") return false;
  if (typeof v.data === "string") return typeof v.mimeType === "string";
  return typeof v.url === "string" && (v.mimeType === undefined || typeof v.mimeType === "string");
}

function fromDataURL(url: string): ImagePart {
  const match = DATA_URL.exec(url);
  if (!match) throw new TypeError(`resolveImages: only base64 data: URLs are supported, got "${shown(url)}"`);
  return { type: "image", mimeType: match[1] as string, data: match[2] as string };
}

function resolveParts(parts: readonly ContentPart[], resolve: ImageResolver | undefined): MaybePromise<ContentPart[]> {
  const out: ContentPart[] = [];
  const from = (start: number): MaybePromise<ContentPart[]> => {
    for (let i = start; i < parts.length; i++) {
      const part = parts[i] as ContentPart;
      if (part.type === "text" || "data" in part) {
        out.push(part);
        continue;
      }
      const { url } = part;
      if (/^data:/i.test(url)) {
        out.push(fromDataURL(url));
        continue;
      }
      if (!resolve) throw new TypeError(`resolveImages: no resolver for image URL "${shown(url)}"`);
      return andThen(resolve(url), (image) => {
        if (!isImagePart(image))
          throw new TypeError(`resolveImages: the resolver did not return an image for "${shown(url)}"`);
        out.push(!("data" in image) && /^data:/i.test(image.url) ? fromDataURL(image.url) : image);
        return from(i + 1);
      });
    }
    return out;
  };
  return from(0);
}

/**
 * Replaces each image given by URL in user and tool messages: every `data:` URL, including one `resolve` returns,
 * becomes a base64 image; other URLs become what `resolve` returns (which may be another URL). URLs are read one after
 * another, and the result is synchronous when `resolve` is. Messages without such images are returned as the same
 * objects.
 */
export function resolveImages(messages: readonly ChatMessage[], resolve?: ImageResolver): MaybePromise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  const from = (start: number): MaybePromise<ChatMessage[]> => {
    for (let i = start; i < messages.length; i++) {
      const m = messages[i] as ChatMessage;
      if ((m.role !== "user" && m.role !== "tool") || typeof m.content === "string" || !m.content.some(isURLImage)) {
        out.push(m);
        continue;
      }
      return andThen(resolveParts(m.content, resolve), (content) => {
        out.push({ ...m, content });
        return from(i + 1);
      });
    }
    return out;
  };
  return from(0);
}
