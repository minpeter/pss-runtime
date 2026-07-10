import { describe, expect, it, vi } from "vitest";

import {
  createWeatherTools,
  GET_WEATHER_TOOL_NAME,
  type GetWeatherToolResult,
} from "./weather-tools";

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    context: undefined,
    messages: [] as [],
    toolCallId: "call-1",
  };
}

describe("get_weather tool", () => {
  it("geocodes then fetches forecast from Open-Meteo", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                country: "South Korea",
                latitude: 37.57,
                longitude: 126.98,
                name: "Seoul",
                timezone: "Asia/Seoul",
              },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            current: {
              precipitation: 0,
              temperature_2m: 21.5,
              time: "2026-07-10T12:00",
              weather_code: 1,
              wind_speed_10m: 8,
            },
            daily: {
              precipitation_sum: [0.2],
              temperature_2m_max: [26],
              temperature_2m_min: [18],
              time: ["2026-07-10"],
            },
          }),
          { status: 200 }
        )
      );

    const tools = createWeatherTools({ fetchImpl });
    const result = (await tools[GET_WEATHER_TOOL_NAME]?.execute?.(
      { location: "Seoul" },
      toolContext()
    )) as GetWeatherToolResult;

    expect(result).toEqual({
      current: {
        precipitationMm: 0,
        temperatureC: 21.5,
        time: "2026-07-10T12:00",
        weatherCode: 1,
        windSpeedKmh: 8,
      },
      daily: {
        precipitationSumMm: 0.2,
        temperatureMaxC: 26,
        temperatureMinC: 18,
        time: "2026-07-10",
      },
      location: {
        country: "South Korea",
        latitude: 37.57,
        longitude: 126.98,
        name: "Seoul",
        timezone: "Asia/Seoul",
      },
      source: "open-meteo",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
