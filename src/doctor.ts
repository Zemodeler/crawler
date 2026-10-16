/**
 * `crawler doctor <url>`: can Crawler work with this Moodle site?
 *
 * Reads the site's public mobile configuration, the same call run by hand on
 * QMplus, and says whether the mobile web service is on and how students sign
 * in. That output goes in the pull request that adds a university.
 */

export type DoctorReport = {
  site: string;
  reachable: boolean;
  /** One of: works, needs-browser-login-support, not-enabled, not-moodle, unreachable */
  verdict: "works" | "login-not-supported" | "not-enabled" | "not-moodle" | "unreachable";
  sitename: string | null;
  webServices: boolean | null;
  mobileService: boolean | null;
  loginType: "app" | "browser" | "embedded" | null;
  identityProviders: string[];
  lines: string[];
};

type PublicConfig = {
  sitename?: string;
  enablewebservices?: number | boolean;
  enablemobilewebservice?: number | boolean;
  typeoflogin?: number;
  identityproviders?: { name?: string }[];
  maintenanceenabled?: number | boolean;
};

const LOGIN_TYPES = { 1: "app", 2: "browser", 3: "embedded" } as const;

export async function doctor(url: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<DoctorReport> {
  let site: string;
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    site = `${parsed.protocol}//${parsed.host}`;
  } catch {
    return report(url, "unreachable", { lines: [`"${url}" is not a web address.`] });
  }

  let config: PublicConfig | null;
  try {
    const response = await fetchImpl(`${site}/lib/ajax/service.php?info=tool_mobile_get_public_config&nosessionupdate=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ index: 0, methodname: "tool_mobile_get_public_config", args: {} }]),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return report(site, "not-moodle", { reachable: true, lines: [`${site} answered HTTP ${response.status}; it does not look like a Moodle site.`] });
    const body = (await response.json().catch(() => null)) as { error?: boolean; data?: PublicConfig }[] | null;
    config = Array.isArray(body) && body[0] && !body[0].error ? (body[0].data ?? null) : null;
  } catch (error) {
    return report(site, "unreachable", { lines: [`Could not reach ${site}: ${error instanceof Error ? error.message : String(error)}`] });
  }
  if (!config) {
    return report(site, "not-moodle", { reachable: true, lines: [`${site} did not return Moodle's public mobile configuration. Either it is not Moodle, or the mobile service is switched off.`] });
  }

  const webServices = Boolean(Number(config.enablewebservices));
  const mobileService = Boolean(Number(config.enablemobilewebservice));
  const loginType = LOGIN_TYPES[config.typeoflogin as 1 | 2 | 3] ?? null;
  const providers = (config.identityproviders ?? []).map((p) => p.name ?? "(unnamed)");
  const lines = [
    `Site: ${config.sitename ?? site}`,
    `Web services: ${webServices ? "on" : "OFF"}`,
    `Mobile web service: ${mobileService ? "on" : "OFF"}`,
    `Sign-in: ${loginType ?? "unknown"}${providers.length ? ` (${providers.join(", ")})` : ""}`,
  ];

  let verdict: DoctorReport["verdict"];
  if (!webServices || !mobileService) {
    verdict = "not-enabled";
    lines.push("Crawler cannot use this site: the university has not enabled the Moodle mobile service.");
  } else if (loginType === "app") {
    verdict = "login-not-supported";
    lines.push("The site signs students in with a username and password inside the Moodle app. Crawler never handles passwords, so it needs the browser sign-in; this site does not offer it.");
  } else {
    verdict = "works";
    lines.push("Crawler should work with this site: sign-in happens on the university's own page.");
  }
  if (Number(config.maintenanceenabled)) lines.push("Note: the site is in maintenance mode right now.");

  return { site, reachable: true, verdict, sitename: config.sitename ?? null, webServices, mobileService, loginType, identityProviders: providers, lines };
}

function report(site: string, verdict: DoctorReport["verdict"], extra: { reachable?: boolean; lines: string[] }): DoctorReport {
  return {
    site,
    reachable: extra.reachable ?? false,
    verdict,
    sitename: null,
    webServices: null,
    mobileService: null,
    loginType: null,
    identityProviders: [],
    lines: extra.lines,
  };
}
