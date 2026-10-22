import type { ImageContent } from "@pi-web/shared";
import { useState } from "react";
import { Modal } from "../../../components/ui";
import { cn } from "../../../lib/cn";

export function imageSrc(image: Pick<ImageContent, "data" | "mimeType">): string {
	return `data:${image.mimeType || "image/png"};base64,${image.data}`;
}

/** Image thumbnails (user messages, read results); click opens a full-size preview. */
export function ImageThumbs({ images, className, size = 160 }: { images: readonly ImageContent[]; className?: string; size?: number }) {
	const [open, setOpen] = useState<number | null>(null);
	if (images.length === 0) return null;
	const current = open !== null ? images[open] : undefined;
	return (
		<div className={cn("flex flex-wrap gap-2", className)}>
			{images.map((image, i) => (
				<button
					key={i}
					type="button"
					onClick={() => setOpen(i)}
					aria-label={`查看图片 ${i + 1}`}
					className="overflow-hidden rounded-md border border-border bg-code p-0 hover:border-border-strong"
				>
					<img src={imageSrc(image)} alt="" className="block object-contain" style={{ maxWidth: size, maxHeight: size }} />
				</button>
			))}
			<Modal open={current !== undefined} onClose={() => setOpen(null)} title={`图片 ${open !== null ? open + 1 : ""}`} size="xl">
				{current && <img src={imageSrc(current)} alt="" className="mx-auto block max-h-[70vh] max-w-full rounded-md" />}
			</Modal>
		</div>
	);
}
