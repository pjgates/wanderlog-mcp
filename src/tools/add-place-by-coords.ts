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

export const addPlaceByCoordsInputSchema = {
  trip_key: z
    .string()
    .min(1)
    .describe("The trip to add to. Use wanderlog_list_trips if you don't know the key."),
  latitude: z
    .number()
    .describe("Latitude of the exact location (e.g. 33.543167)."),
  longitude: z
    .number()
    .describe("Longitude of the exact location (e.g. 134.294972)."),
  radius: z
    .number()
    .optional()
    .default(500)
    .describe("Search radius in metres around the coordinates. Default 500."),
  note: z
    .string()
    .optional()
    .describe(
      "Optional inline note attached directly to this place. Appears on the place itself in Wanderlog.",
    ),
  day: z
    .string()
    .optional()
    .describe(
      "Optional day to add the place to. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Omit to add to 'Places to visit'.",
    ),
};

export const addPlaceByCoordsDescription = `
Adds a place to a Wanderlog trip by GPS coordinates rather than by name.

Finds the nearest named Google Places establishment within the search radius,
resolves its full place details, and inserts it into the trip — with an optional
inline note attached directly to the place.

Requires GOOGLE_PLACES_API_KEY to be set in the server environment.

Use this instead of wanderlog_add_place when you have exact coordinates (e.g. a
Pokélid location, a Pokéstop, a specific pin from a map) and want the nearest
real named place rather than a fuzzy name search.
`.trim();

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
      "Check that GOOGLE_PLACES_API_KEY is valid and the Places API (New) is enabled in your Google Cloud project.",
    );
  }

  const data = (await response.json()) as { places?: NearbyPlace[] };
  const places = data.places ?? [];

  if (places.length === 0) {
    throw new WanderlogError(
      `No places found within ${radius}m of (${latitude}, ${longitude})`,
      "no_nearby_place",
      "Try increasing the radius, or use wanderlog_add_place with a place name instead.",
    );
  }

  return places[0]!;
}

type Args = {
  trip_key: string;
  latitude: number;
  longitude: number;
  radius?: number;
  note?: string;
  day?: string;
};

export async function addPlaceByCoords(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const apiKey = ctx.config.googlePlacesApiKey;
    if (!apiKey) {
      throw new WanderlogValidationError(
        "GOOGLE_PLACES_API_KEY is not configured",
        "Add GOOGLE_PLACES_API_KEY to the wanderlog server env in your MCP config.",
      );
    }

    const userId = requireUserId(ctx);
    const entry = await ctx.tripCache.getEntry(args.trip_key);
    const trip = entry.snapshot;

    // Step 1 — find nearest named place via Google Places API (New)
    const nearby = await findNearestPlace(
      apiKey,
      args.latitude,
      args.longitude,
      args.radius ?? 500,
    );

    // Step 2 — resolve full place details via Wanderlog (uses the same place_id)
    const detail = await ctx.rest.getPlaceDetails(nearby.id);

    // Step 3 — find target section and insert block
    const target = findTargetSection(trip, args.day);
    const block = buildPlaceBlock(detail, userId);
    const insertIndex = target.section.blocks.length;
    const blockPath = ["itinerary", "sections", target.index, "blocks", insertIndex];

    await submitOp(ctx, args.trip_key, [{ p: blockPath, li: block }]);

    // Step 4 — attach inline note if provided
    if (args.note) {
      await submitOp(ctx, args.trip_key, [
        {
          p: [...blockPath, "text"],
          t: "rich-text",
          o: [{ insert: `${args.note}\n` }],
        },
      ]);
    }

    const parts = [
      `Added ${detail.name} (nearest to ${args.latitude}, ${args.longitude}) to ${target.label} in "${trip.title}".`,
    ];
    if (args.note) {
      const preview = args.note.length > 60 ? `${args.note.slice(0, 57)}…` : args.note;
      parts.push(`Note: "${preview}"`);
    }

    return { content: [{ type: "text", text: parts.join(" ") }] };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}
