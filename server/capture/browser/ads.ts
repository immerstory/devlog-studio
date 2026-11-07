import type { Page } from "puppeteer-core";

/** Request patterns of ad networks and native-ad widgets. The browser doesn't load them, so their slots stay empty. */
export const AD_URLS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.", "googletagservices.com", "amazon-adsystem.com",
  "taboola.com", "outbrain.com", "criteo.com", "criteo.net", "adnxs.com", "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com",
  "teads.tv", "smartadserver.com", "adform.net", "yieldlove", "seedtag.com", "sharethrough.com", "33across.com", "media.net", "mgid.com",
  "revcontent.com", "zergnet.com", "nativo.com", "adsrvr.org", "indexww.com", "bidswitch.net", "ad.plus", "adition.com", "stroeer", "uimserv.net",
].map((domain) => `*${domain}*`);

/** Slots and widgets of ads that are left in the page after their requests are blocked. */
export const AD_CSS = [
  "ins.adsbygoogle", "[id^='div-gpt-ad']", "[id^='google_ads_iframe']", "[data-ad-slot]", "[data-ad-unit]", "[data-google-query-id]",
  "[aria-label='Advertisement' i]", "[aria-label='Anzeige' i]", "[class*='taboola' i]", "[id*='taboola' i]", "[class*='outbrain' i]", "[id*='outbrain' i]",
  ".ad-container", ".ad-slot", ".ad-wrapper", ".advert", ".advertisement", ".adsbox", "iframe[src*='ads']",
].map((selector) => `${selector} { display: none !important; }`).join("\n");

/** Blocks ad networks for the page's requests. Call it before the page loads. */
export async function blockAds(page: Page) {
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Network.setBlockedURLs", { urls: AD_URLS });
}

/**
 * Hides the messages a site puts in an empty ad slot, such as "accept cookies or become a member", together with the
 * slot when it holds nothing else. Returns how many. A string, not a function, for the page.
 */
export const hideAdPleas = (page: Page) => page.evaluate(`(() => {
  const plea = /(accept|allow) (cookies|ads|advertising)|ad ?blocker|werbeblocker|(become|be) a (member|subscriber)|disable your ad/i;
  let hidden = 0;
  for (const el of document.querySelectorAll("body div, body aside, body section, body p")) {
    const text = (el.innerText || "").trim();
    if (!text || text.length > 200 || !plea.test(text) || el.querySelector("article, h1, h2")) continue;
    let target = el;
    while (target.parentElement && target.parentElement !== document.body && (target.parentElement.innerText || "").trim() === text) target = target.parentElement;
    target.style.setProperty("display", "none", "important");
    hidden++;
  }
  return hidden;
})()`) as Promise<number>;
