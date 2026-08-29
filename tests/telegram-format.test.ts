import { describe, it, expect } from "vitest";
import { toTelegramHtml, toPlainText } from "../apps/buyer/src/telegram-format.js";

const PAY_URL = "https://emacs-representation-low-try.trycloudflare.com/pay/chk_01m1rmncy1p0w1r21npwt8je2c?t=5xtgJo3y5jh9QYSRjHGrKLtisJQUOVuN";

describe("toTelegramHtml", () => {
  it("renders bold and italics as Telegram tags", () => {
    expect(toTelegramHtml("**Total Paid:** ₹349")).toBe("<b>Total Paid:</b> ₹349");
    expect(toTelegramHtml("a *single* emphasis")).toBe("a <i>single</i> emphasis");
    expect(toTelegramHtml("***both***")).toBe("<b><i>both</i></b>");
  });

  it("escapes HTML so model text can never inject tags", () => {
    expect(toTelegramHtml("5 < 6 & 7 > 2")).toBe("5 &lt; 6 &amp; 7 &gt; 2");
    expect(toTelegramHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("leaves identifiers with underscores alone", () => {
    // var_fc8020_250 and chk_...
    const s = "Order chk_01m1rk4mfz4hnyt04kgyss6mz0 for var_fc8020_250";
    expect(toTelegramHtml(s)).toBe(s);
  });

  it("keeps a payment URL intact and unwrapped", () => {
    expect(toTelegramHtml(`Pay here:\n${PAY_URL}`)).toBe(`Pay here:\n${PAY_URL}`);
    // A self-link renders as the URL once, not a 100-character anchor label.
    expect(toTelegramHtml(`[${PAY_URL}](${PAY_URL})`)).toBe(PAY_URL);
  });

  it("renders a labelled link as an anchor", () => {
    expect(toTelegramHtml("[pay page](https://example.com/x)")).toBe('<a href="https://example.com/x">pay page</a>');
  });

  it("turns headings into bold and bullets into a bullet character", () => {
    expect(toTelegramHtml("## Details\n- one\n* two")).toBe("<b>Details</b>\n• one\n• two");
  });

  it("renders a realistic order summary", () => {
    const out = toTelegramHtml("Here are your options:\n- **Filter Coffee 80:20**, ₹349 (250 g)\n- **Chicory Blend**, ₹379 (250 g)");
    expect(out).toBe("Here are your options:\n• <b>Filter Coffee 80:20</b>, ₹349 (250 g)\n• <b>Chicory Blend</b>, ₹379 (250 g)");
  });
});

describe("toPlainText (the fallback if Telegram rejects the HTML)", () => {
  it("strips markup without losing content", () => {
    expect(toPlainText("**Total:** ₹349")).toBe("Total: ₹349");
    expect(toPlainText(`[${PAY_URL}](${PAY_URL})`)).toBe(PAY_URL);
  });

  it("leaves ordinary text and ids untouched", () => {
    const s = "Order chk_01m1rk4mfz4hnyt04kgyss6mz0 is ₹349 (1 × 250 g). Ready?";
    expect(toPlainText(s)).toBe(s);
  });
});
