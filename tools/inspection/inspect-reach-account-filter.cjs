const { chromium } = require('playwright');

(async () => {
  try {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    const context = browser.contexts()[0];
    const pages = context.pages();

    let origPage = pages.find(p => p.url().includes('zalotool.net'));
    if (!origPage) { console.log('No zalotool page found'); return; }

    // Find where "Lọc tài khoản" is located
    const locTK = await origPage.evaluate(() => {
      const labels = document.querySelectorAll('label');
      for (const l of labels) {
        if (l.textContent?.includes('Lọc tài khoản')) {
          const parent = l.closest('[class*="MuiFormControl"]') || l.parentElement;
          const grandParent = parent?.parentElement;
          const r = parent?.getBoundingClientRect();
          return {
            text: l.textContent,
            position: r ? { top: r.top, left: r.left, width: r.width } : null,
            parentTag: grandParent?.tagName,
            parentClass: grandParent?.className?.substring(0, 100),
            // is it inside header, sidebar, or main?
            inHeader: !!l.closest('header'),
            inSidebar: !!l.closest('[class*="MuiDrawer"]'),
            inMain: !!l.closest('main'),
            grandParentText: grandParent?.textContent?.trim().substring(0, 100),
          };
        }
      }
      return 'not found';
    });
    console.log('Lọc tài khoản location:', JSON.stringify(locTK, null, 2));

    // Also check what the header contains in detail
    const headerDetail = await origPage.evaluate(() => {
      const header = document.querySelector('header');
      if (!header) return 'no header';
      // Check if Lọc tài khoản is in header
      const hasLocTK = header.innerText?.includes('Lọc tài khoản');
      // All form controls in header
      const formControls = header.querySelectorAll('[class*="MuiFormControl"], input, select');
      return {
        hasLocTK,
        formControlCount: formControls.length,
        formControlTexts: Array.from(formControls).map(f => f.textContent?.trim().substring(0, 50)),
        headerFullText: header.innerText?.substring(0, 300),
      };
    });
    console.log('\nHeader detail:', JSON.stringify(headerDetail, null, 2));

    // Check the exact layout around "Tài khoản:" area
    const accountArea = await origPage.evaluate(() => {
      const mainEl = document.querySelector('main');
      const grids = mainEl?.querySelectorAll('[class*="MuiGrid-item"]');
      if (!grids?.[0]) return 'no grid';
      const left = grids[0];
      
      // Get children of the left grid
      const children = left.children;
      const childInfo = [];
      for (let i = 0; i < Math.min(children.length, 10); i++) {
        const c = children[i];
        childInfo.push({
          tag: c.tagName,
          textPreview: c.innerText?.substring(0, 80).replace(/\n/g, ' | '),
          hasFormControl: !!c.querySelector('[class*="MuiFormControl"]'),
        });
      }
      return childInfo;
    });
    console.log('\nLeft col children:', JSON.stringify(accountArea, null, 2));

  } catch (e) {
    console.error('Error:', e.message);
  }
})();
