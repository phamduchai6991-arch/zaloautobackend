const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const publicDir = path.resolve(__dirname, '../../public');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  const page = contexts[0].pages().find(p => p.url().includes('zalotool'));
  if (!page) { console.log('No zalotool page found'); process.exit(1); }

  const svgContent = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let textNode;
    while (textNode = walker.nextNode()) {
      if (textNode.textContent.includes('Ảnh/Video/File đính kèm')) {
        const container = textNode.parentElement.closest('div[class]')?.parentElement?.parentElement || textNode.parentElement.parentElement;
        const svg = container.querySelector('svg');
        if (svg) return svg.outerHTML;
        break;
      }
    }
    return null;
  });

  if (svgContent) {
    fs.writeFileSync(path.join(publicDir, 'upload-illustration.svg'), svgContent, 'utf8');
    console.log('SVG saved! Length:', svgContent.length);
  } else {
    console.log('SVG not found');
  }
  await browser.close();
})();
