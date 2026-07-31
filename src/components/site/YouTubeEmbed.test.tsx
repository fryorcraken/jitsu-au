import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { YouTubeEmbed } from "./YouTubeEmbed";

describe("YouTubeEmbed", () => {
  it("renders an embed iframe pointed at the given video, privacy-enhanced", () => {
    render(<YouTubeEmbed videoId="jm75EhP1zMQ" title="UTS Jitsu class in action" />);
    const iframe = screen.getByTitle("UTS Jitsu class in action");
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe).toHaveAttribute(
      "src",
      "https://www.youtube-nocookie.com/embed/jm75EhP1zMQ?rel=0&cc_load_policy=0",
    );
    expect(iframe).toHaveAttribute("loading", "lazy");
  });
});
