const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes('zalotool'));

  // Get all interactive elements with more detail
  const details = await page.evaluate(() => {
    // Get all switches/toggles
    const switches = document.querySelectorAll('[class*="MuiSwitch"], input[type="checkbox"]');
    const switchDetails = [];
    switches.forEach(s => {
      const parent = s.closest('[class*="MuiFormControlLabel"]') || s.parentElement?.parentElement;
      const label = parent?.textContent?.trim().substring(0, 80) || '';
      switchDetails.push({ label, checked: s.querySelector('input')?.checked || s.checked });
    });

    // Get all tabs  
    const tabs = document.querySelectorAll('[role="tab"]');
    const tabDetails = Array.from(tabs).map(t => ({
      text: t.textContent?.trim(),
      selected: t.getAttribute('aria-selected')
    }));

    // Get all text fields
    const textFields = document.querySelectorAll('textarea, input[type="text"], input[type="number"]');
    const fieldDetails = Array.from(textFields).map(f => ({
      placeholder: f.placeholder,
      value: f.value,
      type: f.type,
      label: f.closest('[class*="MuiFormControl"]')?.querySelector('label')?.textContent || '',
    }));

    // Get sidebar menu items
    const navItems = document.querySelectorAll('nav a, [class*="MuiListItemButton"], [class*="nav"] a');
    const navDetails = Array.from(navItems).map(n => ({
      text: n.textContent?.trim().substring(0, 50),
      href: n.getAttribute('href'),
      active: n.className?.includes('active') || n.getAttribute('aria-selected') === 'true'
    }));

    // Buttons
    const buttons = document.querySelectorAll('button');
    const btnDetails = Array.from(buttons).map(b => ({
      text: b.textContent?.trim().substring(0, 80),
      disabled: b.disabled,
      hasIcon: b.querySelector('svg') !== null,
    })).filter(b => b.text);

    return { switchDetails, tabDetails, fieldDetails, navDetails, btnDetails };
  });

  console.log('=== SWITCHES/TOGGLES ===');
  details.switchDetails.forEach((s, i) => console.log(`${i+1}. "${s.label}" checked=${s.checked}`));

  console.log('\n=== DATA SOURCE TABS ===');
  details.tabDetails.forEach((t, i) => console.log(`${i+1}. "${t.text}" selected=${t.selected}`));

  console.log('\n=== INPUT FIELDS ===');
  details.fieldDetails.forEach((f, i) => console.log(`${i+1}. type=${f.type} placeholder="${f.placeholder}" value="${f.value}" label="${f.label}"`));

  console.log('\n=== SIDEBAR NAV ===');
  details.navDetails.forEach((n, i) => console.log(`${i+1}. "${n.text}" href=${n.href}`));

  console.log('\n=== BUTTONS ===');
  details.btnDetails.forEach((b, i) => console.log(`${i+1}. "${b.text}" disabled=${b.disabled} hasIcon=${b.hasIcon}`));

  // Now explore sidebar links
  console.log('\n\n=== EXPLORING SIDEBAR LINKS ===');
  const sidebarLinks = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href]');
    return Array.from(links).map(l => ({
      text: l.textContent?.trim().substring(0, 50),
      href: l.href,
    })).filter(l => l.href.includes('zalotool'));
  });
  sidebarLinks.forEach((l, i) => console.log(`${i+1}. "${l.text}" -> ${l.href}`));

  // Get the grid layout info
  const layoutInfo = await page.evaluate(() => {
    const grids = document.querySelectorAll('[class*="MuiGrid"]');
    return Array.from(grids).map(g => ({
      classes: Array.from(g.classList).filter(c => c.includes('Grid')).join(' '),
      childCount: g.children.length,
      textPreview: g.textContent?.trim().substring(0, 100),
    }));
  });
  console.log('\n=== GRID LAYOUT ===');
  layoutInfo.forEach((g, i) => console.log(`${i+1}. ${g.classes} children=${g.childCount}`));

  // Check header elements
  const headerInfo = await page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return 'No header found';
    const chips = header.querySelectorAll('[class*="MuiChip"], [class*="badge"], button');
    return Array.from(chips).map(c => c.textContent?.trim().substring(0, 50)).filter(Boolean);
  });
  console.log('\n=== HEADER ELEMENTS ===');
  headerInfo.forEach?.((h, i) => console.log(`${i+1}. "${h}"`));

})();
