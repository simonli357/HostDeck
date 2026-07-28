import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

const requiredAxeTags = Object.freeze([
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
  "best-practice"
]);

export async function expectAxeClean(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags([...requiredAxeTags])
    .analyze();
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary
    }))
  }));
  expect(
    violations,
    `${label} has axe violations:\n${JSON.stringify(violations, null, 2)}`
  ).toEqual([]);
}

export async function expectPageSemantics(
  page: Page,
  expectedTitle: string
): Promise<void> {
  await expect(page).toHaveTitle(expectedTitle);
  const semantics = await page.evaluate(() => {
    const isRendered = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        element.closest('[aria-hidden="true"], [hidden]') === null
      );
    };
    const headings = [...document.querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6")]
      .filter(isRendered)
      .map((heading) => ({
        level: Number.parseInt(heading.tagName.slice(1), 10),
        text: heading.textContent?.trim() ?? ""
      }));
    return {
      mainCount: document.querySelectorAll("main").length,
      h1Count: document.querySelectorAll("h1").length,
      headings,
      positiveTabIndexes: [...document.querySelectorAll<HTMLElement>("[tabindex]")]
        .filter((element) => element.tabIndex > 0)
        .map((element) => element.outerHTML.slice(0, 240)),
      duplicateIds: [...document.querySelectorAll<HTMLElement>("[id]")]
        .map((element) => element.id)
        .filter((id, index, ids) => id !== "" && ids.indexOf(id) !== index)
    };
  });

  expect(semantics.mainCount).toBe(1);
  expect(semantics.h1Count).toBe(1);
  expect(semantics.headings[0]?.level).toBe(1);
  expect(semantics.headings[0]?.text.length).toBeGreaterThan(0);
  for (const [index, heading] of semantics.headings.entries()) {
    const previous = semantics.headings[index - 1];
    if (previous !== undefined) {
      expect(
        heading.level,
        `Heading ${JSON.stringify(heading.text)} skips a level after ${JSON.stringify(previous.text)}`
      ).toBeLessThanOrEqual(previous.level + 1);
    }
  }
  expect(semantics.positiveTabIndexes).toEqual([]);
  expect(semantics.duplicateIds).toEqual([]);
}

export async function expectValidDefinitionLists(page: Page): Promise<void> {
  const failures = await page.evaluate(() => {
    const invalid: string[] = [];
    const describe = (element: Element) => {
      const className = element.getAttribute("class");
      return className === null
        ? element.tagName.toLowerCase()
        : `${element.tagName.toLowerCase()}.${className.trim().replaceAll(/\s+/gu, ".")}`;
    };

    for (const list of document.querySelectorAll("dl")) {
      for (const child of list.children) {
        if (child.matches("dt, dd")) continue;
        if (!child.matches("div")) {
          invalid.push(`${describe(list)} has invalid direct child ${describe(child)}`);
          continue;
        }
        const grouped = [...child.children];
        if (
          grouped.length < 2 ||
          !grouped.some((element) => element.matches("dt")) ||
          !grouped.some((element) => element.matches("dd")) ||
          grouped.some((element) => !element.matches("dt, dd"))
        ) {
          invalid.push(`${describe(list)} has invalid group ${describe(child)}`);
        }
      }
    }

    for (const item of document.querySelectorAll("dt, dd")) {
      const parent = item.parentElement;
      if (
        parent === null ||
        (!parent.matches("dl") && !(parent.matches("div") && parent.parentElement?.matches("dl")))
      ) {
        invalid.push(`${describe(item)} is not owned by a definition list`);
      }
    }
    return invalid;
  });
  expect(failures).toEqual([]);
}

export async function expectLiveRegionContract(page: Page): Promise<void> {
  const failures = await page.evaluate(() => {
    const invalid: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(
      '[role="alert"][aria-live="polite"], [role="alert"][aria-live="off"]'
    )) {
      invalid.push(`Contradictory urgent live region: ${element.outerHTML.slice(0, 240)}`);
    }
    for (const element of document.querySelectorAll<HTMLElement>("[aria-live]")) {
      if (
        element.querySelector(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])'
        ) !== null
      ) {
        invalid.push(`Live region owns an enabled control: ${element.outerHTML.slice(0, 240)}`);
      }
    }
    for (const status of document.querySelectorAll<HTMLElement>(
      '[aria-live="polite"]:not([role="status"])'
    )) {
      if (status.getAttribute("aria-atomic") !== "true") {
        invalid.push(`Explicit polite live region is not atomic: ${status.outerHTML.slice(0, 240)}`);
      }
    }
    return invalid;
  });
  expect(failures).toEqual([]);
}

export async function expectCoreTargets(page: Page): Promise<void> {
  const failures = await page.evaluate(() => {
    const isRendered = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0 &&
        element.closest('[aria-hidden="true"], [hidden]') === null
      );
    };
    const describe = (element: HTMLElement) =>
      element.getAttribute("aria-label") ??
      element.textContent?.trim().replaceAll(/\s+/gu, " ").slice(0, 100) ??
      element.tagName.toLowerCase();
    const invalid: string[] = [];
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        "button, .hostdeck-session-row, textarea, input[type='search']"
      )
    ].filter(isRendered);
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) {
        invalid.push(
          `${describe(control)} measures ${rect.width.toFixed(1)} x ${rect.height.toFixed(1)}`
        );
      }
      const core = control.matches(
        ".hostdeck-action-button, .hostdeck-primary-action-dock__command, .hostdeck-primary-button"
      );
      if (core && (rect.width < 44 || rect.height < 44)) {
        invalid.push(
          `Core target ${describe(control)} measures ${rect.width.toFixed(1)} x ${rect.height.toFixed(1)}`
        );
      }
    }
    return invalid;
  });
  expect(failures).toEqual([]);
}

export async function expectDisabledContrastPolicy(page: Page): Promise<void> {
  const failures = await page.evaluate(() => {
    type Rgba = readonly [number, number, number, number];
    const parseColor = (value: string): Rgba | null => {
      const hex = value.trim().match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/iu)?.[1];
      if (hex !== undefined) {
        return [
          Number.parseInt(hex.slice(0, 2), 16),
          Number.parseInt(hex.slice(2, 4), 16),
          Number.parseInt(hex.slice(4, 6), 16),
          hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
        ];
      }
      const channels = value.match(/[\d.]+/gu)?.map(Number);
      if (channels === undefined || channels.length < 3) return null;
      return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
    };
    const luminance = ([red, green, blue]: Rgba) => {
      const linear = (channel: number) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };
    const ratio = (foreground: Rgba, background: Rgba) => {
      const first = luminance(foreground);
      const second = luminance(background);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const opaqueBackground = (element: HTMLElement): Rgba => {
      let current: HTMLElement | null = element;
      while (current !== null) {
        const color = parseColor(getComputedStyle(current).backgroundColor);
        if (color !== null && color[3] >= 0.999) return color;
        current = current.parentElement;
      }
      return [18, 19, 19, 1];
    };
    const describe = (element: HTMLElement) =>
      element.getAttribute("aria-label") ??
      element.textContent?.trim().replaceAll(/\s+/gu, " ").slice(0, 100) ??
      element.tagName.toLowerCase();
    const invalid: string[] = [];
    for (const control of document.querySelectorAll<HTMLElement>(
      "button:disabled, input:disabled, textarea:disabled"
    )) {
      const rect = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      if (
        rect.width === 0 ||
        rect.height === 0 ||
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity) === 0
      ) {
        continue;
      }
      for (const current of [control, ...control.querySelectorAll<HTMLElement>("*")]) {
        if (Number.parseFloat(getComputedStyle(current).opacity) < 1) {
          invalid.push(control.outerHTML.slice(0, 240));
          break;
        }
      }

      const background = opaqueBackground(control);
      const foreground = parseColor(style.color);
      if ((control.textContent?.trim() ?? "") !== "" && foreground !== null) {
        const textRatio = ratio(foreground, background);
        if (textRatio < 4.5) {
          invalid.push(
            `${describe(control)} disabled text contrast is ${textRatio.toFixed(2)}:1`
          );
        }
      }
      for (const icon of control.querySelectorAll<SVGElement>("svg")) {
        const iconStyle = getComputedStyle(icon);
        const iconColor = parseColor(iconStyle.color);
        if (iconColor !== null && ratio(iconColor, background) < 3) {
          invalid.push(
            `${describe(control)} disabled icon contrast is ${ratio(iconColor, background).toFixed(2)}:1`
          );
        }
      }
      const borders = [
        [style.borderTopStyle, style.borderTopWidth, style.borderTopColor],
        [style.borderRightStyle, style.borderRightWidth, style.borderRightColor],
        [style.borderBottomStyle, style.borderBottomWidth, style.borderBottomColor],
        [style.borderLeftStyle, style.borderLeftWidth, style.borderLeftColor]
      ];
      for (const [borderStyle, borderWidth, borderColorValue] of borders) {
        const borderColor = parseColor(borderColorValue ?? "");
        if (
          borderStyle !== "none" &&
          Number.parseFloat(borderWidth ?? "0") > 0 &&
          borderColor !== null &&
          borderColor[3] > 0 &&
          ratio(borderColor, background) < 3
        ) {
          invalid.push(
            `${describe(control)} disabled boundary contrast is ${ratio(borderColor, background).toFixed(2)}:1`
          );
          break;
        }
      }
    }
    return invalid;
  });
  expect(failures).toEqual([]);
}

export interface ThemeContrastContractResult {
  readonly pairs: Readonly<{
    primaryText: number;
    disabledText: number;
    disabledBoundary: number;
    controlBoundary: number;
    focusIndicator: number;
  }>;
  readonly actualPrimary: number | null;
}

export async function expectThemeContrastContract(
  page: Page
): Promise<ThemeContrastContractResult> {
  const result = await page.evaluate(() => {
    type Rgba = readonly [number, number, number, number];
    const parseColor = (value: string): Rgba => {
      const hex = value.trim().match(/^#([0-9a-f]{6}|[0-9a-f]{8})$/iu)?.[1];
      if (hex !== undefined) {
        return [
          Number.parseInt(hex.slice(0, 2), 16),
          Number.parseInt(hex.slice(2, 4), 16),
          Number.parseInt(hex.slice(4, 6), 16),
          hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
        ];
      }
      const channels = value.match(/[\d.]+/gu)?.map(Number);
      if (channels === undefined || channels.length < 3) {
        throw new TypeError(`Unsupported computed color: ${value}`);
      }
      return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
    };
    const luminance = ([red, green, blue]: Rgba) => {
      const linear = (channel: number) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
    };
    const ratio = (firstColor: Rgba, secondColor: Rgba) => {
      const first = luminance(firstColor);
      const second = luminance(secondColor);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const rootStyle = getComputedStyle(document.documentElement);
    const token = (name: string) => parseColor(rootStyle.getPropertyValue(name));
    const canvas = token("--hostdeck-canvas");
    const surface = token("--hostdeck-surface");
    const focus = token("--hostdeck-focus");
    const disabledInk = token("--hostdeck-disabled-ink");
    const disabledBorder = token("--hostdeck-disabled-border");
    const disabledSurface = token("--hostdeck-disabled-surface");
    const controlBorder = token("--hostdeck-control-border");
    const pairs = {
      primaryText: ratio(canvas, focus),
      disabledText: Math.min(
        ratio(disabledInk, canvas),
        ratio(disabledInk, surface),
        ratio(disabledInk, disabledSurface)
      ),
      disabledBoundary: Math.min(
        ratio(disabledBorder, canvas),
        ratio(disabledBorder, surface),
        ratio(disabledBorder, disabledSurface)
      ),
      controlBoundary: Math.min(ratio(controlBorder, canvas), ratio(controlBorder, surface)),
      focusIndicator: Math.min(ratio(focus, canvas), ratio(focus, surface))
    };
    const primary = document.querySelector<HTMLElement>(
      ".hostdeck-primary-button:not(:disabled)"
    );
    const primaryStyle = primary === null ? null : getComputedStyle(primary);
    return {
      pairs,
      actualPrimary: primaryStyle === null
        ? null
        : ratio(parseColor(primaryStyle.color), parseColor(primaryStyle.backgroundColor))
    };
  });

  expect(result.pairs.primaryText, "Primary control text contrast").toBeGreaterThanOrEqual(4.5);
  expect(result.pairs.disabledText, "Disabled text contrast").toBeGreaterThanOrEqual(4.5);
  expect(result.pairs.disabledBoundary, "Disabled boundary contrast").toBeGreaterThanOrEqual(3);
  expect(result.pairs.controlBoundary, "Control boundary contrast").toBeGreaterThanOrEqual(3);
  expect(result.pairs.focusIndicator, "Focus indicator contrast").toBeGreaterThanOrEqual(3);
  if (result.actualPrimary !== null) {
    expect(result.actualPrimary, "Rendered primary control text contrast").toBeGreaterThanOrEqual(4.5);
  }
  return result;
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

export async function expectDialogFocusCycle(
  page: Page,
  dialog: Locator
): Promise<void> {
  await expect(dialog).toBeVisible();
  const probeCount = await dialog.evaluate((element) => {
    const selector = [
      "button:not([disabled])",
      "a[href]",
      "input:not([disabled])",
      "textarea:not([disabled])",
      "select:not([disabled])",
      '[tabindex="0"]'
    ].join(",");
    const candidates = [...element.querySelectorAll<HTMLElement>(selector)].filter((candidate) => {
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      return (
        candidate.tabIndex >= 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    for (const [index, candidate] of candidates.entries()) {
      candidate.dataset.hostdeckA11yProbe = String(index);
    }
    return candidates.length;
  });
  expect(probeCount).toBeGreaterThan(1);

  const first = dialog.locator('[data-hostdeck-a11y-probe="0"]');
  const last = dialog.locator(`[data-hostdeck-a11y-probe="${probeCount - 1}"]`);
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await first.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
  await dialog.evaluate((element) => {
    for (const candidate of element.querySelectorAll<HTMLElement>("[data-hostdeck-a11y-probe]")) {
      delete candidate.dataset.hostdeckA11yProbe;
    }
  });
}

export async function expectFocusInViewport(page: Page): Promise<void> {
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName.toLowerCase(),
      name: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 120) ?? "",
      rect: {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        height: rect.height,
        width: rect.width
      },
      viewport: { height: window.innerHeight, width: window.innerWidth },
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth
    };
  });
  expect(focus).not.toBeNull();
  expect(focus?.rect.top).toBeGreaterThanOrEqual(0);
  expect(focus?.rect.left).toBeGreaterThanOrEqual(0);
  expect(focus?.rect.right).toBeGreaterThan(0);
  expect(focus?.rect.bottom).toBeGreaterThan(0);
  if ((focus?.rect.width ?? 0) <= (focus?.viewport.width ?? 0) + 1) {
    expect(focus?.rect.right).toBeLessThanOrEqual((focus?.viewport.width ?? 0) + 1);
  }
  if ((focus?.rect.height ?? 0) <= (focus?.viewport.height ?? 0) + 1) {
    expect(focus?.rect.bottom).toBeLessThanOrEqual((focus?.viewport.height ?? 0) + 1);
  }
  expect(Number.parseFloat(focus?.outlineWidth ?? "0")).toBeGreaterThanOrEqual(3);
  expect(focus?.outlineStyle).not.toBe("none");
}

export async function expectReducedMotion(page: Page): Promise<void> {
  const failures = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".hostdeck-spin")]
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.animationName !== "none" || style.transitionDuration !== "0s";
      })
      .map((element) => ({
        className: element.className,
        animationName: getComputedStyle(element).animationName,
        transitionDuration: getComputedStyle(element).transitionDuration
      }))
  );
  expect(failures).toEqual([]);
}
