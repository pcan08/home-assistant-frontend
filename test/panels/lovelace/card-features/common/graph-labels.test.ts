import { describe, expect, it } from "vitest";
import { computeDayLabels } from "../../../../../src/panels/lovelace/card-features/common/graph-labels";
import {
  DateFormat,
  FirstWeekday,
  NumberFormat,
  TimeFormat,
  TimeZone,
} from "../../../../../src/data/translation";
import type { FrontendLocaleData } from "../../../../../src/data/translation";
import { demoConfig } from "../../../../../src/fake_data/demo_config";

const locale = (
  dateFormat: DateFormat,
  language = "en"
): FrontendLocaleData => ({
  language,
  number_format: NumberFormat.language,
  time_format: TimeFormat.language,
  date_format: dateFormat,
  time_zone: TimeZone.local,
  first_weekday: FirstWeekday.language,
});

describe("computeDayLabels", () => {
  const entries = [
    { datetime: "2017-11-18T12:00:00Z" }, // Saturday
    { datetime: "2017-11-20T12:00:00Z" }, // Monday
  ];

  it("Formats narrow weekday labels", () => {
    expect(
      computeDayLabels(
        entries,
        1,
        "weekday",
        locale(DateFormat.language),
        demoConfig
      )
    ).toEqual(["S", "M"]);
  });

  it("Formats numeric date labels following date_format", () => {
    expect(
      computeDayLabels(entries, 1, "date", locale(DateFormat.DMY), demoConfig)
    ).toEqual(["18/11", "20/11"]);
  });

  it("Steps through entries per day for twice-daily forecasts", () => {
    const twiceDaily = [
      { datetime: "2017-11-18T06:00:00Z" },
      { datetime: "2017-11-18T18:00:00Z" },
      { datetime: "2017-11-20T06:00:00Z" },
      { datetime: "2017-11-20T18:00:00Z" },
    ];
    expect(
      computeDayLabels(
        twiceDaily,
        2,
        "date",
        locale(DateFormat.DMY),
        demoConfig
      )
    ).toEqual(["18/11", "20/11"]);
  });
});
