import { z } from "zod";

import type { WorkerAgentToolSet } from "./tools";

export const GET_WEATHER_TOOL_NAME = "get_weather";

const DEFAULT_GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const DEFAULT_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const GetWeatherInputSchema = z
  .object({
    location: z
      .string()
      .min(1)
      .describe(
        "City, region, or place name to look up (e.g. Seoul, Tokyo, San Francisco)."
      ),
  })
  .strict();

export interface GetWeatherToolResult {
  readonly current: {
    readonly precipitationMm: number | null;
    readonly temperatureC: number | null;
    readonly time: string | null;
    readonly weatherCode: number | null;
    readonly windSpeedKmh: number | null;
  };
  readonly daily: {
    readonly precipitationSumMm: number | null;
    readonly temperatureMaxC: number | null;
    readonly temperatureMinC: number | null;
    readonly time: string | null;
  };
  readonly location: {
    readonly country: string | null;
    readonly latitude: number;
    readonly longitude: number;
    readonly name: string;
    readonly timezone: string | null;
  };
  readonly source: "open-meteo";
}

export interface WeatherToolsOptions {
  readonly fetchImpl?: typeof fetch;
  readonly forecastUrl?: string;
  readonly geocodeUrl?: string;
}

export class WeatherToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherToolError";
  }
}

export function createWeatherTools(
  options: WeatherToolsOptions = {}
): WorkerAgentToolSet {
  const fetchImpl = options.fetchImpl ?? fetch;
  const geocodeUrl = options.geocodeUrl ?? DEFAULT_GEOCODE_URL;
  const forecastUrl = options.forecastUrl ?? DEFAULT_FORECAST_URL;

  return {
    [GET_WEATHER_TOOL_NAME]: {
      description:
        "Get current weather and today's forecast for a place using free Open-Meteo data (no API key). Use for temperature, rain, wind, or conditions in a city — not for web search or chat.",
      execute: async (input: unknown): Promise<GetWeatherToolResult> => {
        const parsed = GetWeatherInputSchema.parse(input);
        const locationName = parsed.location.trim();
        const place = await geocodeLocation(
          fetchImpl,
          geocodeUrl,
          locationName
        );
        const weather = await fetchForecast(
          fetchImpl,
          forecastUrl,
          place.latitude,
          place.longitude
        );
        return {
          current: weather.current,
          daily: weather.daily,
          location: {
            country: place.country,
            latitude: place.latitude,
            longitude: place.longitude,
            name: place.name,
            timezone: place.timezone,
          },
          source: "open-meteo",
        };
      },
      inputSchema: GetWeatherInputSchema,
    },
  };
}

interface GeocodedPlace {
  readonly country: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly name: string;
  readonly timezone: string | null;
}

async function geocodeLocation(
  fetchImpl: typeof fetch,
  geocodeUrl: string,
  location: string
): Promise<GeocodedPlace> {
  const url = new URL(geocodeUrl);
  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetchImpl(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new WeatherToolError(
      `Open-Meteo geocoding failed (${response.status}).`
    );
  }
  const body = (await response.json()) as {
    readonly results?: readonly {
      readonly country?: string;
      readonly latitude: number;
      readonly longitude: number;
      readonly name: string;
      readonly timezone?: string;
    }[];
  };
  const first = body.results?.[0];
  if (!first) {
    throw new WeatherToolError(`No place found for "${location}".`);
  }
  return {
    country: first.country ?? null,
    latitude: first.latitude,
    longitude: first.longitude,
    name: first.name,
    timezone: first.timezone ?? null,
  };
}

async function fetchForecast(
  fetchImpl: typeof fetch,
  forecastUrl: string,
  latitude: number,
  longitude: number
): Promise<Pick<GetWeatherToolResult, "current" | "daily">> {
  const url = new URL(forecastUrl);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,precipitation,weather_code,wind_speed_10m"
  );
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_sum"
  );
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("timezone", "auto");

  const response = await fetchImpl(url.toString(), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new WeatherToolError(
      `Open-Meteo forecast failed (${response.status}).`
    );
  }
  const body = (await response.json()) as {
    readonly current?: {
      readonly precipitation?: number;
      readonly temperature_2m?: number;
      readonly time?: string;
      readonly weather_code?: number;
      readonly wind_speed_10m?: number;
    };
    readonly daily?: {
      readonly precipitation_sum?: readonly (number | null)[];
      readonly temperature_2m_max?: readonly (number | null)[];
      readonly temperature_2m_min?: readonly (number | null)[];
      readonly time?: readonly string[];
    };
  };

  return {
    current: {
      precipitationMm: body.current?.precipitation ?? null,
      temperatureC: body.current?.temperature_2m ?? null,
      time: body.current?.time ?? null,
      weatherCode: body.current?.weather_code ?? null,
      windSpeedKmh: body.current?.wind_speed_10m ?? null,
    },
    daily: {
      precipitationSumMm: body.daily?.precipitation_sum?.[0] ?? null,
      temperatureMaxC: body.daily?.temperature_2m_max?.[0] ?? null,
      temperatureMinC: body.daily?.temperature_2m_min?.[0] ?? null,
      time: body.daily?.time?.[0] ?? null,
    },
  };
}
