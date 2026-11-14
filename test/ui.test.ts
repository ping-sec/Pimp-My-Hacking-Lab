import { describe, expect, test } from "bun:test";
const html = await Bun.file(new URL("../ui/index.html", import.meta.url)).text();

describe("UI", () => {
  test("ISC-1 welcome has exactly one primary action and Advanced starts collapsed", () => {
    expect(html.match(/data-primary/g)?.length).toBe(1);
    expect(html).toContain(">Set up my lab</button>");
    expect(html).toMatch(/<details class="adv" id="adv">/);
    expect(html).not.toMatch(/<details class="adv" id="adv" open/);
  });
  test("ISC-3 virtualization off shows a brand-specific BIOS guide", () => {
    expect(html).toContain('id="bios"');
    for (const key of ["dell", "hp", "lenovo", "asus", "acer", "msi"]) expect(html).toMatch(new RegExp(`${key}: \\{ label: "[^"]+", key: "`));
    expect(html).toContain("Intel Virtualization Technology");
    expect(html).toContain("SVM Mode");
  });
  test("ISC-7 errors show what happened, what to do, and Copy help bundle", () => {
    expect(html).toContain('id="e-what"');
    expect(html).toContain('id="e-todo"');
    expect(html).toContain(">Copy help bundle</button>");
  });
  test("ISC-9 ready page covers opening Kali, the login, and web-lab links", () => {
    expect(html).toContain("Your lab is ready");
    expect(html).toContain("<code>kali</code>");
    expect(html).toContain('id="r-labs"');
    expect(html).toMatch(/WEB_LABS = \[ \["/);
  });
  test("ISC-50 a step's question gets its own screen with one yes button", () => {
    expect(html).toContain('id="s-ask"');
    expect(html).toContain('id="q-what"');
    expect(html).toContain('id="q-todo"');
    expect(html).toMatch(/<button class="btn" id="q-yes">Upgrade VirtualBox<\/button>/);
    expect(html).toContain('post("/api/confirm")');
    expect(html).toMatch(/if \(s\.question\)/);
  });
  test("ISC-51 hidden always wins over a component's display, so the demo panel never shows in a real run", () => {
    expect(html).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important\s*\}/);
  });
});

describe("on-screen log (F13)", () => {
  test("ISC-65 progress and error screens have a collapsed Show details panel filled as text, following the newest line", () => {
    for (const id of ["p-log", "e-log"]) {
      expect(html).toMatch(new RegExp(`<details class="adv log" id="${id}"><summary>Show details</summary>`));
      expect(html).not.toMatch(new RegExp(`id="${id}" open`));
    }
    expect(html).toContain('get(`/api/log?after=${after}`)');
    expect(html).toMatch(/row\.textContent = /);
    expect(html).not.toMatch(/innerHTML[^;\n]*\.text\b/);
    expect(html).toMatch(/scrollHeight - box\.scrollTop - box\.clientHeight/);
  });
});
