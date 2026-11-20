import { z } from "zod";

/** Prompt metadata listing the OmO markers taken out of a stored user prompt's text. */
export const markerMetadata = "omsago.markers";

/**
 * OmO tags its own prompts with HTML comments such as `<!-- OMO_INTERNAL_NOREPLY -->` and reads
 * them back from history to recognize its notices. Native history and the model get the text
 * without them; the legacy history OmO reads shows them again.
 */
const marker = /\s*<!--\s*OMO_[A-Z_]+\s*-->/g;

export function hideMarkers(text: string): { text: string; markers: string[] } {
  const markers = text.match(marker)?.map((found) => found.trim()) ?? [];
  return { text: markers.length === 0 ? text : text.replace(marker, "").trimEnd(), markers };
}

export function showMarkers(
  text: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
): string {
  const stored = metadata?.[markerMetadata];
  if (stored === undefined) return text;
  return [text, ...z.array(z.string()).parse(stored)].join("\n");
}
