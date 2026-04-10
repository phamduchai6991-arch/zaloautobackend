const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('zalotool'));
  if (!page) { console.log('No zalotool page found'); process.exit(1); }

  const data = await page.evaluate(() => {
    const res = {};

    // 1. ALL buttons with their text, disabled state, click handlers
    const buttons = document.querySelectorAll('button');
    res.buttons = Array.from(buttons).filter(b => b.offsetParent !== null).map(b => {
      const cs = getComputedStyle(b);
      return {
        text: b.textContent.trim().substring(0, 60),
        disabled: b.disabled,
        ariaLabel: b.getAttribute('aria-label'),
        className: b.className.substring(0, 80),
        width: b.offsetWidth,
        height: b.offsetHeight,
        bgColor: cs.backgroundColor,
        color: cs.color,
        borderRadius: cs.borderRadius,
        border: cs.border,
        cursor: cs.cursor,
        role: b.getAttribute('role'),
        type: b.type,
      };
    });

    // 2. ALL switches/toggles
    const switches = document.querySelectorAll('input[type="checkbox"][role="switch"], .MuiSwitch-input');
    res.switches = Array.from(switches).map(s => {
      const label = s.closest('.MuiFormControlLabel-root')?.textContent?.trim() ||
                    s.closest('.MuiSwitch-root')?.parentElement?.textContent?.trim();
      return {
        checked: s.checked,
        disabled: s.disabled,
        label: label?.substring(0, 50),
      };
    });

    // 3. ALL text inputs/textareas
    const inputs = document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]):not([type="file"]), textarea');
    res.inputs = Array.from(inputs).filter(i => i.offsetParent !== null || i.closest('[class*="MuiInput"]')).map(i => {
      const label = i.closest('.MuiFormControl-root')?.querySelector('label')?.textContent?.trim();
      return {
        tag: i.tagName,
        type: i.type,
        value: i.value?.substring(0, 50),
        placeholder: i.placeholder?.substring(0, 50),
        label: label?.substring(0, 50),
        disabled: i.disabled,
        readOnly: i.readOnly,
        rows: i.rows || null,
        width: i.offsetWidth,
      };
    });

    // 4. ALL tabs
    const tabs = document.querySelectorAll('[role="tab"]');
    res.tabs = Array.from(tabs).map(t => ({
      text: t.textContent.trim(),
      selected: t.getAttribute('aria-selected') === 'true',
      disabled: t.disabled || t.getAttribute('aria-disabled') === 'true',
    }));

    // 5. ALL select/dropdown elements
    const selects = document.querySelectorAll('select, [role="combobox"], [role="listbox"], .MuiSelect-select');
    res.selects = Array.from(selects).filter(s => s.offsetParent !== null).map(s => ({
      text: s.textContent?.trim().substring(0, 60),
      value: s.value,
      role: s.getAttribute('role'),
      ariaLabel: s.getAttribute('aria-label'),
    }));

    // 6. ALL checkboxes
    const checkboxes = document.querySelectorAll('input[type="checkbox"]:not([role="switch"]):not(.MuiSwitch-input)');
    res.checkboxes = Array.from(checkboxes).map(c => ({
      checked: c.checked,
      label: c.closest('.MuiFormControlLabel-root')?.textContent?.trim().substring(0, 50),
      ariaLabel: c.getAttribute('aria-label'),
    }));

    // 7. ALL links
    const links = document.querySelectorAll('a[href]');
    res.links = Array.from(links).filter(l => l.offsetParent !== null).map(l => ({
      text: l.textContent.trim().substring(0, 60),
      href: l.href,
      target: l.target,
    }));

    // 8. File input
    const fileInputs = document.querySelectorAll('input[type="file"]');
    res.fileInputs = Array.from(fileInputs).map(f => ({
      accept: f.accept,
      multiple: f.multiple,
    }));

    // 9. Sidebar menu items with their click behavior
    const menuItems = document.querySelectorAll('[role="menuitem"], .MuiListItemButton-root, .MuiListItem-root');
    res.menuItems = Array.from(menuItems).filter(m => m.offsetParent !== null).map(m => ({
      text: m.textContent.trim().substring(0, 60),
      active: m.classList.contains('Mui-selected') || m.getAttribute('aria-selected') === 'true',
      hasLink: !!m.closest('a'),
      href: m.closest('a')?.href || null,
    }));

    // 10. Badges
    const badges = document.querySelectorAll('.MuiBadge-badge');
    res.badges = Array.from(badges).filter(b => b.offsetParent !== null).map(b => ({
      text: b.textContent.trim(),
      color: getComputedStyle(b).backgroundColor,
    }));

    // 11. Tooltips or popovers
    const tooltips = document.querySelectorAll('[data-popper-placement], [role="tooltip"]');
    res.tooltips = tooltips.length;

    // 12. Dialog/Modal triggers
    res.dialogTriggers = [];
    buttons.forEach(b => {
      const ariaControls = b.getAttribute('aria-controls');
      const ariaHaspopup = b.getAttribute('aria-haspopup');
      if (ariaControls || ariaHaspopup) {
        res.dialogTriggers.push({
          text: b.textContent.trim().substring(0, 40),
          ariaControls,
          ariaHaspopup,
        });
      }
    });

    return res;
  });

  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})();
