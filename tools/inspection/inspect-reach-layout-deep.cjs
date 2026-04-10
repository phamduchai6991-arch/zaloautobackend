const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('zalotool'));
  if (!page) { console.log('No zalotool page found'); process.exit(1); }

  const data = await page.evaluate(() => {
    const res = {};
    
    // Find the attachment upload area more thoroughly - look for dashed border
    const allDivs = document.querySelectorAll('div');
    for (const div of allDivs) {
      const cs = getComputedStyle(div);
      if (cs.borderStyle === 'dashed' || cs.borderStyle.includes('dashed')) {
        // Found the dashed container
        const imgs = div.querySelectorAll('img');
        const svgs = div.querySelectorAll('svg');
        res.dashedContainer = {
          innerHTML: div.innerHTML.substring(0, 2000),
          childImages: Array.from(imgs).map(i => ({ src: i.src, alt: i.alt })),
          childSVGs: Array.from(svgs).map(s => s.outerHTML.substring(0, 500)),
          text: div.textContent.substring(0, 200),
        };
        break;
      }
    }

    // Find Bắt Đầu button using contains text match
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = btn.textContent.trim();
      if (text.includes('Bắt') && text.includes('Đầu')) {
        res.batDauButton = {
          innerHTML: btn.innerHTML.substring(0, 2000),
          text: btn.textContent.trim(),
          className: btn.className,
        };
        break;
      }
    }

    // Find all SVG with viewBox inside buttons
    const btnSvgs = document.querySelectorAll('button svg');
    res.buttonSVGs = Array.from(btnSvgs).slice(0, 10).map(svg => ({
      viewBox: svg.getAttribute('viewBox'),
      parentText: svg.closest('button')?.textContent?.trim().substring(0, 30),
      paths: Array.from(svg.querySelectorAll('path')).map(p => p.getAttribute('d')?.substring(0, 80)),
    }));

    return res;
  });

  console.log(JSON.stringify(data, null, 2));
  await browser.close();
})();
