import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogValidationError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import {
  buildPlaceBlock,
  findTargetSection,
  requireUserId,
  submitOp,
} from "./shared.js";

const placeEntrySchema = z.object({
  latitude: z.number().describe("Latitude of the exact location."),
  longitude: z.number().describe("Longitude of the exact location."),
  radius: z.number().optional().default(500).describe("Search radius in metres. Default 500."),
  note: z.string().optional().describe("Inline note attached directly to this place."),
  day: z
    .string()
    .optional()
    .describe("Day to add the place to. Omit to add to 'Places to visit'."),
});

export const addPlacesByCoordsBatchInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip to add to. Use wanderlog_list_trips if you don't know the key."),
  places: z
    .array(placeEntrySchema)
    .min(1)
    .max(50)
    .describe(
      "List of places to add, each with latitude, longitude, optional radius, optional note, and optional day. Processed sequentially to avoid race conditions.",
    ),
};

export const addPlacesByCoordsBatchDescription = `
Adds multiple places to a Wanderlog trip by GPS coordinates in a single call.

For each entry, finds the nearest named Google Places establishment within the
search radius, resolves its full place details, and inserts it — with an optional
inline note attached directly to the place.

Places are added sequentially (not in parallel) so notes always land on the
correct place. Use this instead of calling wanderlog_add_place_by_coords multiple
times to avoid race conditions.

Requires GOOGLE_PLACES_API_KEY to be set in the server environment.
`.trim();

type PlaceEntry = {
  latitude: number;
  longitude: number;
  radius?: number;
  note?: string;
  day?: string;
};

type NearbyPlace = {
  id: string;
  displayName: { text: string; languageCode: string };
  formattedAddress: string;
  location: { latitude: number; longitude: number };
};

async function findNearestPlace(
  apiKey: string,
  latitude: number,
  longitude: number,
  radius: number,
): Promise<NearbyPlace> {
  const body = {
    locationRestriction: {
      circle: {
        center: { latitude, longitude },
        radius: Math.max(radius, 50),
      },
    },
    maxResultCount: 1,
    languageCode: "en",
  };

  const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new WanderlogError(
      `Google Places API error ${response.status}: ${text}`,
      "google_places_error",
      "Check that GOOGLE_PLACES_API_KEY is valid and the Places API (New) is enabled.",
    );
  }

  const data = (await response.json()) as { places?: NearbyPlace[] };
  const places = data.places ?? [];

  if (places.length === 0) {
    throw new WanderlogError(
      `No places found within ${radius}m of (${latitude}, ${longitude})`,
      "no_nearby_place",
      "Try increasing the radius, or use wanderlog_add_place with a name instead.",
    );
  }

  return places[0]!;
}

type Args = {
  trip_key: string;
  places: PlaceEntry[];
};

type Result = { coords: string; name: string; status: "ok"; note?: string } | { coords: string; status: "error"; error: string };

export async function addPlacesByCoordsBatch(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const apiKey = ctx.config.googlePlacesApiKey;
  if (!apiKey) {
    return {
      content: [{
        type: "text",
        text: new WanderlogValidationError(
          "GOOGLE_PLACES_API_KEY is not configured",
          "Add GOOGLE_PLACES_API_KEY to the wanderlog server env in your MCP config.",
        ).toUserMessage(),
      }],
      isError: true,
    };
  }

  const userId = requireUserId(ctx);
  const results: Result[] = [];

  // Sequential — each awaits the previous so block indices are always fresh
  for (const entry of args.places) {
    const coords = `(${entry.latitude}, ${entry.longitude})`;
    try {
      // Fresh snapshot each iteration so section.blocks.length is current
      const snapshot = await ctx.tripCache.getEntry(args.trip_key);
      const trip = snapshot.snapshot;

      const nearby = await findNearestPlace(
        apiKey,
        entry.latitude,
        entry.longitude,
        entry.radius ?? 500,
      );

      const detail = await ctx.rest.getPlaceDetails(nearby.id);

      const target = findTargetSection(trip, entry.day);
      const block = buildPlaceBlock(detail, userId);
      const insertIndex = target.section.blocks.length;
      const blockPath = ["itinerary", "sections", target.index, "blocks", insertIndex];

      await submitOp(ctx, args.trip_key, [{ p: blockPath, li: block } as Json0Op]);

      if (entry.note) {
        await submitOp(ctx, args.trip_key, [
          {
            p: [...blockPath, "text"],
            t: "rich-text",
            o: [{ insert: `${entry.note}\n` }],
          } as Json0Op,
        ]);
      }

      results.push({ coords, name: detail.name, status: "ok", note: entry.note });
    } catch (err) {
      const error =
        err instanceof WanderlogError
          ? err.toUserMessage()
          : `Unexpected error: ${(err as Error).message}`;
      results.push({ coords, status: "error", error });
    }
  }

  const ok = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "error");

  const lines: string[] = [`Added ${ok.length}/${results.length} places to "${(await ctx.tripCache.getEntry(args.trip_key)).snapshot.title}".`];

  if (ok.length > 0) {
    lines.push("\n✅ Added:");
    for (const r of ok) {
      if (r.status === "ok") {
        lines.push(`  • ${r.name} ${r.coords}${r.note ? ` — "${r.note.split("\n")[0]}"` : ""}`);
      }
    }
  }

  if (failed.length > 0) {
    lines.push("\n❌ Failed:");
    for (const r of failed) {
      if (r.status === "error") {
        lines.push(`  • ${r.coords}: ${r.error}`);
      }
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
