import { describe, expect, it } from "vitest";
import {
	basename,
	formatBytes,
	formatClock,
	formatCost,
	formatDate,
	formatDuration,
	formatDurationZh,
	formatPercent,
	formatRelativeTime,
	formatTokens,
	tildify,
	truncate,
} from "./format";

describe("formatBytes", () => {
	it("formats with compact units", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1331)).toBe("1.3 KB");
		expect(formatBytes(28.9 * 1024 * 1024)).toBe("28.9 MB");
		expect(formatBytes(312 * 1024 * 1024)).toBe("312 MB");
		expect(formatBytes(118 * 1024 ** 3)).toBe("118 GB");
		expect(formatBytes(Number.NaN)).toBe("-");
		expect(formatBytes(undefined)).toBe("-");
	});
});

describe("formatRelativeTime", () => {
	const now = new Date(2026, 9, 22, 15, 0, 0).getTime();
	it("handles recent times", () => {
		expect(formatRelativeTime(now - 3_000, now)).toBe("刚刚");
		expect(formatRelativeTime(now - 42_000, now)).toBe("42 秒前");
		expect(formatRelativeTime(now - 3 * 60_000, now)).toBe("3 分钟前");
		expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe("2 小时前");
	});
	it("uses calendar days for older times", () => {
		expect(formatRelativeTime(new Date(2026, 9, 21, 23, 0).getTime(), now)).toBe("昨天");
		expect(formatRelativeTime(new Date(2026, 9, 19, 9, 0).getTime(), now)).toBe("3 天前");
		expect(formatRelativeTime(new Date(2026, 9, 8, 9, 0).getTime(), now)).toBe("2 周前");
		expect(formatRelativeTime(new Date(2026, 2, 5, 9, 0).getTime(), now)).toBe("3月5日");
		expect(formatRelativeTime(new Date(2025, 2, 5, 9, 0).getTime(), now)).toBe("2025年3月5日");
	});
	it("handles future times", () => {
		expect(formatRelativeTime(now + 42 * 60_000, now)).toBe("42 分钟后");
		expect(formatRelativeTime(now + 2_000, now)).toBe("马上");
	});
	it("formats dates", () => {
		expect(formatDate(new Date(2026, 0, 2).getTime(), now)).toBe("1月2日");
	});
});

describe("durations", () => {
	it("formats compact durations", () => {
		expect(formatDuration(300)).toBe("0.3s");
		expect(formatDuration(4200)).toBe("4.2s");
		expect(formatDuration(12_400)).toBe("12s");
		expect(formatDuration(192_000)).toBe("3m 12s");
		expect(formatDuration(3_900_000)).toBe("1h 05m");
		expect(formatDuration(-1)).toBe("-");
	});
	it("formats Chinese durations", () => {
		expect(formatDurationZh(4200)).toBe("4.2 秒");
		expect(formatDurationZh(42 * 60_000)).toBe("42 分钟");
		expect(formatDurationZh(3 * 3_600_000 + 5 * 60_000)).toBe("3 小时 5 分钟");
		expect(formatDurationZh(2 * 3_600_000)).toBe("2 小时");
		expect(formatDurationZh(3 * 86_400_000 + 1000)).toBe("3 天");
	});
	it("formats clocks", () => {
		expect(formatClock(10_000)).toBe("0:10");
		expect(formatClock(723_000)).toBe("12:03");
		expect(formatClock(3_723_000)).toBe("1:02:03");
	});
});

describe("formatTokens", () => {
	it("matches the artboard style", () => {
		expect(formatTokens(980)).toBe("980");
		expect(formatTokens(9_800)).toBe("9.8k");
		expect(formatTokens(68_100)).toBe("68.1k");
		expect(formatTokens(21_040)).toBe("21.0k");
		expect(formatTokens(200_000)).toBe("200k");
		expect(formatTokens(1_234_567)).toBe("1.2M");
		expect(formatTokens(2_000_000)).toBe("2M");
		expect(formatTokens(999_990)).toBe("1.0M");
		expect(formatTokens(undefined)).toBe("-");
	});
});

describe("formatCost / percent", () => {
	it("formats USD", () => {
		expect(formatCost(0)).toBe("$0.00");
		expect(formatCost(0.004)).toBe("<$0.01");
		expect(formatCost(0.62)).toBe("$0.62");
		expect(formatCost(12.3)).toBe("$12.30");
		expect(formatCost(1234.4)).toBe("$1,234");
	});
	it("formats percentages", () => {
		expect(formatPercent(0.34)).toBe("34%");
		expect(formatPercent(1.5)).toBe("100%");
		expect(formatPercent(0.3456, 1)).toBe("34.6%");
	});
});

describe("text helpers", () => {
	it("truncates and flattens", () => {
		expect(truncate("hello\n  world", 20)).toBe("hello world");
		expect(truncate("abcdefghij", 5)).toBe("abcd…");
	});
	it("tildifies paths", () => {
		expect(tildify("/home/dev/projects/x", "/home/dev")).toBe("~/projects/x");
		expect(tildify("/home/dev", "/home/dev/")).toBe("~");
		expect(tildify("/srv/x", "/home/dev")).toBe("/srv/x");
		expect(tildify("/srv/x", undefined)).toBe("/srv/x");
	});
	it("takes basenames", () => {
		expect(basename("/a/b/c.txt")).toBe("c.txt");
		expect(basename("/a/b/")).toBe("b");
		expect(basename("file")).toBe("file");
	});
});
