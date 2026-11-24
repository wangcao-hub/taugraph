import { describe, expect, it } from "vitest";
import { type ChatMessage, type ContentPart, resolveImages, textOf } from "../src/nodes/index.js";

const png = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

describe("textOf", () => {
  it("returns the text of a message's content", () => {
    expect(textOf("hi")).toBe("hi");
    expect(
      textOf([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });

  it("refuses images unless told what to write instead", () => {
    const content = [{ type: "text" as const, text: "see " }, png];
    expect(() => textOf(content)).toThrow(/has images and this adapter sends text only/);
    expect(textOf(content, { imagePlaceholder: "[image]" })).toBe("see [image]");
  });

  it("drops images with an empty placeholder", () => {
    expect(
      textOf([{ type: "text", text: "see " }, png, { type: "text", text: "this" }], { imagePlaceholder: "" }),
    ).toBe("see this");
  });
});

describe("resolveImages", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", url: "media:a" }, png] },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shot", arguments: {} }] },
    { role: "tool", toolCallId: "c1", content: [{ type: "image", url: "data:image/jpeg;base64,/9j/4AAQ" }] },
    { role: "user", content: "plain" },
  ];

  it("reads references with the resolver and decodes data: URLs itself", () => {
    const asked: string[] = [];
    const out = resolveImages(messages, (url) => {
      asked.push(url);
      return { type: "image", data: "QUJD", mimeType: "image/webp" };
    });
    expect(out).not.toBeInstanceOf(Promise);
    expect(asked).toEqual(["media:a"]);
    expect(out).toEqual([
      messages[0],
      {
        role: "user",
        content: [{ type: "text", text: "look" }, { type: "image", data: "QUJD", mimeType: "image/webp" }, png],
      },
      messages[2],
      { role: "tool", toolCallId: "c1", content: [{ type: "image", data: "/9j/4AAQ", mimeType: "image/jpeg" }] },
      messages[4],
    ]);
    const list = out as ChatMessage[];
    expect(list[0]).toBe(messages[0]);
    expect(list[2]).toBe(messages[2]);
    expect(list[4]).toBe(messages[4]);
  });

  it("returns a promise when the resolver is asynchronous", async () => {
    const out = resolveImages(messages, async () => png);
    expect(out).toBeInstanceOf(Promise);
    expect((await out)[1]).toEqual({ role: "user", content: [{ type: "text", text: "look" }, png, png] });
  });

  it("keeps messages without URL images as they are and needs no resolver for them", () => {
    const plain: ChatMessage[] = [
      { role: "user", content: [png] },
      { role: "user", content: "x" },
    ];
    const out = resolveImages(plain) as ChatMessage[];
    expect(out[0]).toBe(plain[0]);
    expect(out[1]).toBe(plain[1]);
  });

  it("decodes a data: URL the resolver returns and keeps an http(s) URL it returns", () => {
    const one: ChatMessage[] = [{ role: "user", content: [{ type: "image", url: "media:a" }] }];
    expect(resolveImages(one, () => ({ type: "image", url: "data:image/png;base64,iVBORw0KGgo=" }))).toEqual([
      { role: "user", content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] },
    ]);
    expect(resolveImages(one, () => ({ type: "image", url: "https://x/a.png" }))).toEqual([
      { role: "user", content: [{ type: "image", url: "https://x/a.png" }] },
    ]);
  });

  it("reads URLs in order, one after another, with an asynchronous resolver", async () => {
    const events: string[] = [];
    const two: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", url: "media:a" },
          { type: "image", url: "media:b" },
        ],
      },
    ];
    await resolveImages(two, async (url) => {
      events.push(`start:${url}`);
      await Promise.resolve();
      events.push(`end:${url}`);
      return png;
    });
    expect(events).toEqual(["start:media:a", "end:media:a", "start:media:b", "end:media:b"]);
  });

  it("takes a part with both data and url as a base64 image, and decodes DATA: URLs", () => {
    const both: ContentPart = { type: "image", data: "QUJD", mimeType: "image/png", url: "media:a" };
    const withBoth: ChatMessage[] = [{ role: "user", content: [both] }];
    const [first] = resolveImages(withBoth) as [ChatMessage];
    expect(first).toBe(withBoth[0]);
    expect((first.content as ContentPart[])[0]).toBe(both);
    const upper: ChatMessage[] = [
      { role: "user", content: [{ type: "image", url: "DATA:image/png;base64,iVBORw0KGgo=" }] },
    ];
    expect(resolveImages(upper)).toEqual([{ role: "user", content: [png] }]);
  });

  it("fails clearly without a resolver, on a bad data: URL, and when the resolver returns no image", () => {
    expect(() => resolveImages(messages)).toThrow(/no resolver for image URL "media:a"/);
    const long: ChatMessage[] = [{ role: "user", content: [{ type: "image", url: `media:${"x".repeat(200)}` }] }];
    expect(() => resolveImages(long)).toThrow(/"media:x{94}…"/);
    const bad: ChatMessage[] = [{ role: "user", content: [{ type: "image", url: "data:image/png,abc" }] }];
    expect(() => resolveImages(bad)).toThrow(/only base64 data: URLs/);
    expect(() => resolveImages(messages, () => ({ type: "text", text: "x" }) as never)).toThrow(
      /did not return an image for "media:a"/,
    );
  });
});
