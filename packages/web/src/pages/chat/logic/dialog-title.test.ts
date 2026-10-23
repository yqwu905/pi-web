import { describe, expect, it } from "vitest";
import { splitDialogTitle } from "./dialog-title";

describe("splitDialogTitle", () => {
	it("keeps a one-line title as the heading", () => {
		expect(splitDialogTitle("你更喜欢哪种语言？")).toEqual({ heading: "你更喜欢哪种语言？", detail: "" });
	});

	it("shows the lines after the first under it, keeping indentation and blank lines", () => {
		const title = "[语言] 你更喜欢哪种语言？\n\n1. Rust — 系统编程\n2. Go — 云原生\n\n  fn main() {}\n\n输入你的回答：\n";
		expect(splitDialogTitle(title)).toEqual({
			heading: "[语言] 你更喜欢哪种语言？",
			detail: "1. Rust — 系统编程\n2. Go — 云原生\n\n  fn main() {}\n\n输入你的回答：",
		});
	});

	it("starts at the first non-empty line", () => {
		expect(splitDialogTitle("\r\n  \r\nQuestion?\r\n  detail")).toEqual({ heading: "Question?", detail: "  detail" });
	});

	it("keeps a blank title as is", () => {
		expect(splitDialogTitle("")).toEqual({ heading: "", detail: "" });
		expect(splitDialogTitle(" \n ")).toEqual({ heading: " \n ", detail: "" });
	});
});
