// End-to-end coverage for TESTING.md steps 1 + 2.
//
//   Step 1 — landing page renders the pricing CTA inside a
//            <form action="/api/checkout"> with a real submit button.
//   Step 2 — clicking the CTA POSTs to the Worker's /api/checkout and the
//            browser is redirected to the URL the Worker returns. We mock
//            the Worker response with page.route() because real Stripe
//            isn't reachable from CI; the assertion is the WIRING (POST
//            sent, body parsed, browser navigated to body.url), not
//            Stripe itself.

import { test, expect } from "@playwright/test";

test.describe("landing page", () => {
  test("renders the pricing CTA form pointed at /api/checkout", async ({ page }) => {
    const consoleErrors = [];
    page.on("pageerror",   (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on("console",     (msg) => { if (msg.type() === "error") consoleErrors.push(`console.error: ${msg.text()}`); });

    const response = await page.goto("/");
    expect(response, "GET / should respond").not.toBeNull();
    expect(response.status(), "GET / should be 200").toBe(200);

    await expect(page).toHaveTitle(/Algosize/i);

    const ctaForm = page.locator('form[action="/api/checkout"]');
    await expect(ctaForm).toBeVisible();
    await expect(ctaForm).toHaveAttribute("method", /post/i);

    const ctaButton = ctaForm.locator('button[type="submit"]');
    await expect(ctaButton).toBeVisible();
    await expect(ctaButton).toBeEnabled();

    expect(consoleErrors, "no console / page errors on the landing page").toEqual([]);
  });

  test("CTA POSTs to /api/checkout and follows the returned URL (Stripe stubbed)", async ({ page }) => {
    // Mock the Worker's checkout endpoint at the browser layer. This proves
    // the FRONTEND wiring (intercept submit -> fetch JSON -> follow url)
    // without depending on Stripe being reachable. The Worker's own
    // checkout handler is covered by worker/scripts/test-stripe.mjs.
    let capturedRequest = null;
    await page.route("**/api/checkout", async (route, request) => {
      capturedRequest = {
        method:  request.method(),
        headers: request.headers(),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        // Return a same-origin URL with a query param we can detect after
        // navigation — keeps the test self-contained (no real Stripe
        // round-trip, no need to spin up a third static server).
        body: JSON.stringify({
          // Same-origin URL (matches baseURL in playwright.config.js) so
          // the post-checkout redirect navigates within the test server.
          url: "http://localhost:5001/?from=stripe-mock",
          id:  "cs_test_e2e_mock_session",
        }),
      });
    });

    await page.goto("/");

    const requestPromise = page.waitForRequest("**/api/checkout");
    await page.locator('form[action="/api/checkout"] button[type="submit"]').first().click();
    const req = await requestPromise;

    expect(req.method(), "checkout request must be POST").toBe("POST");
    expect(capturedRequest, "the Playwright route() captured the request").not.toBeNull();
    expect(capturedRequest.method).toBe("POST");

    // Wait for the redirect that checkout.js issues via window.location.assign.
    await page.waitForURL("**/?from=stripe-mock", { timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get("from")).toBe("stripe-mock");
  });
});
