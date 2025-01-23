const { test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const sharp = require("sharp");
const config = require("../config.js");

let pixelmatch;
let chalk;

// Dynamically load `pixelmatch` and `chalk`
(async () => {
  pixelmatch = (await import("pixelmatch")).default;
  chalk = (await import("chalk")).default;
})();

// Helper Functions

// Ensure directory exists
function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

// Resize images to match specified dimensions (1280x800)
async function resizeImage(imagePath, width, height) {
  const buffer = fs.readFileSync(imagePath);
  const resizedBuffer = await sharp(buffer)
    .resize(width, height, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .toBuffer();
  fs.writeFileSync(imagePath, resizedBuffer);
}

// Compare two screenshots and return similarity percentage
async function compareScreenshots(baselinePath, currentPath, diffPath) {
  await resizeImage(baselinePath, 1280, 800);
  await resizeImage(currentPath, 1280, 800);

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(currentPath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    console.log(
      chalk.red(`Size mismatch for ${baselinePath} and ${currentPath}`)
    );
    return "Size mismatch";
  }

  const diff = new PNG({ width: img1.width, height: img1.height });
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const matchedPixels = totalPixels - mismatchedPixels;
  return (matchedPixels / totalPixels) * 100;
}

// Forcefully capture screenshot for a given URL
async function captureScreenshot(page, url, screenshotPath) {
  try {
    console.log(chalk.blue(`Navigating to: ${url}`));

    const navigationPromise = page.goto(url, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    const timeoutPromise = new Promise(
      (resolve) =>
        setTimeout(() => {
          console.log(
            chalk.red(`Timeout detected on ${url}. Forcing screenshot.`)
          );
          resolve();
        }, 10000) // Timeout after 10 seconds
    );

    await Promise.race([navigationPromise, timeoutPromise]);

    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`Screenshot captured: ${screenshotPath}`));
  } catch (error) {
    console.error(
      chalk.red(`Failed to capture screenshot for ${url}: ${error.message}`)
    );
    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`Forced screenshot captured: ${screenshotPath}`));
  }
}

// Generate HTML report
function generateHtmlReport(results, deviceName) {
  const reportPath = `visual_comparison_report_${deviceName}.html`;
  const now = new Date().toLocaleString();
  const environments = `
    <a href="${config.staging.baseUrl}" target="_blank">Staging: ${config.staging.baseUrl}</a>,
    <a href="${config.prod.baseUrl}" target="_blank">Prod: ${config.prod.baseUrl}</a>
  `;

  let htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Visual Comparison Report - ${deviceName}</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.5; margin: 20px; }
        h1, h2 { text-align: center; }
        .summary { text-align: center; margin: 20px 0; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; }
        th { background-color: #f2f2f2; }
        .pass { color: green; font-weight: bold; }
        .fail { color: red; font-weight: bold; }
        .error { color: orange; font-weight: bold; }
        img { max-width: 150px; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Visual Comparison Report</h1>
      <h2>Device: ${deviceName}</h2>
      <div class="summary">
        <p>Total Pages Tested: ${results.length}</p>
        <p>Passed: ${
          results.filter(
            (r) =>
              typeof r.similarityPercentage === "number" &&
              r.similarityPercentage >= 95
          ).length
        }</p>
        <p>Failed: ${
          results.filter(
            (r) =>
              typeof r.similarityPercentage === "number" &&
              r.similarityPercentage < 95
          ).length
        }</p>
        <p>Errors: ${
          results.filter((r) => r.similarityPercentage === "Error").length
        }</p>
        <p>Last Run: ${now}</p>
        <p>Environments Tested: ${environments}</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Similarity</th>
            <th>Status</th>
            <th>Thumbnail</th>
          </tr>
        </thead>
        <tbody>
  `;

  results.forEach((result) => {
    const diffThumbnailPath = `screenshots/${deviceName}/diff/${result.pagePath.replace(
      /\//g,
      "_"
    )}.png`;

    const stagingUrl = `${config.staging.baseUrl}${result.pagePath}`;
    const prodUrl = `${config.prod.baseUrl}${result.pagePath}`;

    const statusClass =
      typeof result.similarityPercentage === "number" &&
      result.similarityPercentage >= 95
        ? "pass"
        : "fail";

    htmlContent += `
      <tr>
        <td>
          <a href="${stagingUrl}" target="_blank">Staging</a> |
          <a href="${prodUrl}" target="_blank">Prod</a>
        </td>
        <td>${
          typeof result.similarityPercentage === "number"
            ? result.similarityPercentage.toFixed(2) + "%"
            : result.similarityPercentage
        }</td>
        <td class="${statusClass}">${
      result.similarityPercentage === "Error"
        ? "Error"
        : result.similarityPercentage >= 95
        ? "Pass"
        : "Fail"
    }</td>
        <td>${
          fs.existsSync(diffThumbnailPath)
            ? `<a href="${diffThumbnailPath}" target="_blank"><img src="${diffThumbnailPath}" /></a>`
            : "N/A"
        }</td>
      </tr>
    `;
  });

  htmlContent += `
        </tbody>
      </table>
    </body>
    </html>
  `;

  fs.writeFileSync(reportPath, htmlContent);
  console.log(chalk.green(`HTML report generated: ${reportPath}`));
}

// Main Test Suite
test.describe("Visual Comparison Tests", () => {
  test("Compare staging and prod screenshots and generate HTML report", async ({
    browser,
  }) => {
    const results = [];
    const deviceName = "Desktop";

    console.log(chalk.blue("Running tests..."));

    const baseDir = `screenshots/${deviceName}`;
    ["staging", "prod", "diff"].forEach((dir) => {
      if (!fs.existsSync(path.join(baseDir, dir))) {
        fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
      }
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    for (const pagePath of config.staging.urls) {
      const stagingUrl = `${config.staging.baseUrl}${pagePath}`;
      const prodUrl = `${config.prod.baseUrl}${pagePath}`;
      const stagingScreenshotPath = path.join(
        baseDir,
        "staging",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const prodScreenshotPath = path.join(
        baseDir,
        "prod",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const diffScreenshotPath = path.join(
        baseDir,
        "diff",
        `${pagePath.replace(/\//g, "_")}.png`
      );

      try {
        await captureScreenshot(page, stagingUrl, stagingScreenshotPath);
        await captureScreenshot(page, prodUrl, prodScreenshotPath);

        const similarity = await compareScreenshots(
          stagingScreenshotPath,
          prodScreenshotPath,
          diffScreenshotPath
        );

        results.push({ pagePath, similarityPercentage: similarity });
      } catch (error) {
        results.push({
          pagePath,
          similarityPercentage: "Error",
          error: error.message,
        });
      }
    }

    generateHtmlReport(results, deviceName);
    await context.close();
  });

  test("Verify broken image links automatically on staging pages from config.js", async ({
    page,
  }) => {
    const stagingUrls = config.staging.urls.map(
      (url) => `${config.staging.baseUrl}${url}`
    );
  
    for (const url of stagingUrls) {
      console.log(chalk.blue(`Navigating to: ${url}`));
      await page.goto(url, { waitUntil: "domcontentloaded" });
      console.log(chalk.green(`Page loaded successfully: ${url}`));
  
      console.log(chalk.blue("Finding all image elements on the page..."));
      const images = await page.locator("img");
      const imageCount = await images.count();
      console.log(chalk.green(`Found ${imageCount} images on the page.`));
  
      let brokenImages = [];
      let totalImagesChecked = 0;
  
      for (let i = 0; i < imageCount; i++) {
        let imageUrl = await images.nth(i).getAttribute("src");
  
        if (!imageUrl) {
          console.log(
            chalk.yellow(`Image ${i + 1} does not have a valid src attribute.`)
          );
          brokenImages.push({
            imageIndex: i + 1,
            reason: "No valid src attribute",
          });
          continue;
        }
  
        // Handle relative and protocol-relative URLs
        if (!imageUrl.startsWith("http") && !imageUrl.startsWith("//")) {
          imageUrl = new URL(imageUrl, url).toString();
        } else if (imageUrl.startsWith("//")) {
          imageUrl = `https:${imageUrl}`;
        }
  
        try {
          console.log(chalk.blue(`Checking image ${i + 1}: ${imageUrl}`));
          const response = await page.request.get(imageUrl);
  
          if (response.status() !== 200) {
            console.log(
              chalk.red(
                `Image ${i + 1} failed to load. Status Code: ${response.status()}`
              )
            );
            brokenImages.push({
              imageIndex: i + 1,
              imageUrl: imageUrl,
              statusCode: response.status(),
            });
          } else {
            console.log(chalk.green(`Image ${i + 1} loaded successfully.`));
          }
        } catch (error) {
          console.log(
            chalk.red(
              `Image ${i + 1} failed to load. Error: ${error.message}`
            )
          );
          brokenImages.push({
            imageIndex: i + 1,
            imageUrl: imageUrl,
            reason: error.message,
          });
        }
  
        totalImagesChecked++;
      }
  
      console.log(chalk.blue(`Total images checked: ${totalImagesChecked}`));
      console.log(
        chalk.red(
          `Broken images on ${url}: ${brokenImages.length > 0 ? brokenImages.length : "None"}`
        )
      );
  
      if (brokenImages.length > 0) {
        console.log(chalk.red(`Broken image details for ${url}:`));
        brokenImages.forEach((image) => {
          console.log(
            chalk.red(
              `- Image ${image.imageIndex}: ${
                image.imageUrl || "No URL available"
              } (Reason: ${
                image.reason || `Status Code ${image.statusCode}`
              })`
            )
          );
        });
      } else {
        console.log(
          chalk.green(`No broken images found on the page: ${url}.`)
        );
      }
    }
  });
   
  test("Fill out the form one field at a time and submit", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const formPageUrl = "https://live-web-wpunj.pantheonsite.io/";
      console.log(chalk.blue(`Navigating to the form page: ${formPageUrl}`));

      await page.goto(formPageUrl, { waitUntil: "domcontentloaded" });
      console.log(chalk.green("Page partially loaded successfully."));

      // Block unnecessary resources to stabilize the page
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (
          url.endsWith(".png") ||
          url.endsWith(".jpg") ||
          url.endsWith(".css") ||
          url.endsWith(".js")
        ) {
          route.abort();
        } else {
          route.continue();
        }
      });

      console.log(
        chalk.blue("Blocked unnecessary resources to stabilize the page.")
      );

      // Ensure form fields are visible
      await page.waitForSelector("#gform_2", { timeout: 15000 });
      console.log(chalk.green("Form is visible."));

      // Fill out the form
      const testIteration = Date.now(); // Timestamp for unique data
      const firstName = `John${testIteration}`;
      const email = `johndoe${testIteration}@example.com`;

      console.log(chalk.blue("Filling out the form fields..."));

      await page.selectOption("#input_2_11", { index: 1 }); // Select 'Program of Interest'
      console.log(chalk.green("'Program of Interest' selected successfully."));

      await page.fill("#input_2_2", firstName);
      console.log(chalk.green(`'First Name' filled: ${firstName}`));

      await page.fill("#input_2_3", "Doe");
      console.log(chalk.green("'Last Name' filled successfully."));

      await page.fill("#input_2_5", email);
      console.log(chalk.green(`'Email' filled: ${email}`));

      await page.fill("#input_2_6", "5551234567");
      console.log(chalk.green("'Phone' filled successfully."));

      await page.fill("#input_2_7", "12345");
      console.log(chalk.green("'ZIP Code' filled successfully."));

      await page.selectOption("#input_2_8", { index: 2 }); // Select 'How did you hear about us?'
      console.log(
        chalk.green("'How did you hear about us?' selected successfully.")
      );

      // Submit the form
      console.log(chalk.blue("Submitting the form..."));
      await page.click("#gform_submit_button_2");

      // Wait for confirmation message
      console.log(chalk.blue("Waiting for confirmation message..."));
      const confirmationSelector = "h1.header2";
      await page.waitForSelector(confirmationSelector, { timeout: 20000 });

      const confirmationText = await page.textContent(confirmationSelector);

      if (confirmationText.trim() === "Thanks for your submission!") {
        console.log(
          chalk.green(
            "Form submitted successfully and confirmation message displayed."
          )
        );
      } else {
        console.log(
          chalk.red("Confirmation message text did not match expected value.")
        );
      }
    } catch (error) {
      console.error(chalk.red(`Error during test: ${error.message}`));
    } finally {
      await context.close();
    }
  });

  test("Click Apply Now, fill out the form, and submit", async ({ page }) => {
    // Navigate to the homepage
    const homePageUrl = "https://live-web-wpunj.pantheonsite.io/";
    console.log(chalk.blue(`Navigating to the home page: ${homePageUrl}`));
    await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });

    // Click on the "Apply Now" button
    const applyNowSelector =
      "a.button.elementor-button.elementor-button-link.elementor-size-sm";
    console.log(chalk.blue("Clicking on 'Apply Now' button..."));
    await page.waitForSelector(applyNowSelector, { timeout: 10000 });
    await page.click(applyNowSelector);

    // Wait for the form page to load
    const formPageUrl = "https://live-web-wpunj.pantheonsite.io/apply/";
    console.log(
      chalk.blue(`Waiting for navigation to the form page: ${formPageUrl}`)
    );
    await page.waitForURL(formPageUrl, { timeout: 10000 });
    console.log(chalk.green("Navigated to the Apply Now form page."));

    // Fill the form fields
    console.log(chalk.blue("Filling out the Apply Now form fields..."));
    await page.selectOption("#input_4_17", { value: "WPUNJ-M-MBAACCT" }); // Select "MBA – Accounting"
    await page.fill("#input_4_2", "Jane"); // First Name
    await page.fill("#input_4_3", "Smith"); // Last Name
    await page.fill("#input_4_4", "janesmith@example.com"); // Email
    await page.fill("#input_4_5", "5559876543"); // Phone
    await page.fill("#input_4_6", "54321"); // ZIP Code
    await page.selectOption("#input_4_7", { value: "Online" }); // Select "Online"
    console.log(chalk.green("Form fields filled successfully."));

    // Submit the form and wait for navigation to the confirmation page
    console.log(chalk.blue("Submitting the Apply Now form..."));
    await Promise.all([
      page.waitForURL(/\/apply2\/\?d=WPUNJ-M-MBAACCT&entry_id=\d+/, {
        timeout: 30000,
      }),
      page.click("#gform_submit_button_4"),
    ]);
    console.log(
      chalk.green("Form submitted, and navigated to the confirmation page.")
    );

    // Wait for the specific confirmation message
    console.log(
      chalk.blue("Waiting for confirmation message on the confirmation page...")
    );
    const specificConfirmationSelector =
      ".elementor-element.elementor-element-fee00a1 h1.header2";
    try {
      await page.waitForSelector(specificConfirmationSelector, {
        timeout: 15000,
      }); // Wait for the specific confirmation message
      const confirmationText = await page.textContent(
        specificConfirmationSelector
      );

      // Log the confirmation message
      console.log(
        chalk.blue(`Confirmation message found: "${confirmationText.trim()}"`)
      );

      // Verify the confirmation message text
      if (
        confirmationText.trim() ===
        "Great! Now, take the next step to complete your application."
      ) {
        console.log(
          chalk.green(
            "Form submitted successfully, and confirmation message displayed."
          )
        );
      } else {
        console.log(
          chalk.red("Confirmation message text did not match expected value.")
        );
      }
    } catch (error) {
      console.error(
        chalk.red(`Error waiting for confirmation message: ${error.message}`)
      );
    }
  });

  test("Verify Online Programs and Getting Started Menus - WPUNJ", async ({
    page,
  }) => {
    const verifyMenu = async (
      menuName,
      menuSelector,
      submenuSelector,
      linksSelector
    ) => {
      console.log(chalk.blue(`Locating the '${menuName}' menu...`));

      // Locate the menu element
      const menuElement = await page.locator(menuSelector);
      if (!(await menuElement.isVisible())) {
        throw new Error(`The '${menuName}' menu is not visible.`);
      }
      console.log(chalk.green(`The '${menuName}' menu is visible.`));

      // Hover over the menu to display submenus
      console.log(chalk.blue(`Hovering over the '${menuName}' menu...`));
      await menuElement.hover();

      // Locate submenus
      const submenus = await page.locator(submenuSelector);
      const submenuCount = await submenus.count();
      if (submenuCount === 0) {
        throw new Error(`No submenus found for '${menuName}' menu.`);
      }
      console.log(
        chalk.green(`Found ${submenuCount} submenus in the '${menuName}' menu.`)
      );

      // Locate links in the submenus
      const links = await page.locator(linksSelector);
      const linkCount = await links.count();
      if (linkCount === 0) {
        throw new Error(`No links found in the '${menuName}' menu.`);
      }
      console.log(
        chalk.green(`Found ${linkCount} links in the '${menuName}' menu.`)
      );

      // Verify each link
      let invalidLinks = 0;
      for (let i = 0; i < linkCount; i++) {
        const linkText = await links.nth(i).textContent();
        const linkHref = await links.nth(i).getAttribute("href");
        console.log(
          chalk.blue(
            `Checking link ${i + 1} in '${menuName}' menu: ${linkText}`
          )
        );

        if (!linkHref || linkHref.trim() === "") {
          console.log(
            chalk.yellow(
              `Warning: Link '${linkText}' in '${menuName}' menu does not have a valid href attribute.`
            )
          );
          invalidLinks++;
        } else {
          console.log(
            chalk.green(
              `Link '${linkText}' in '${menuName}' menu is valid with href: ${linkHref}`
            )
          );
        }
      }

      console.log(
        chalk.green(
          `All checks complete for '${menuName}' menu. Found ${invalidLinks} invalid links.`
        )
      );

      if (invalidLinks > 0) {
        console.log(
          chalk.yellow(
            `Test completed with ${invalidLinks} warnings for invalid links in the '${menuName}' menu.`
          )
        );
      } else {
        console.log(
          chalk.green(`All links in the '${menuName}' menu are valid.`)
        );
      }
    };

    const homePageUrl = "https://live-web-wpunj.pantheonsite.io/";
    console.log(chalk.blue("Navigating to the WPUNJ homepage..."));
    await page.goto(homePageUrl, { waitUntil: "domcontentloaded" });
    console.log(chalk.green("Homepage loaded successfully."));

    // Verify the "Online Programs" menu
    await verifyMenu(
      "Online Programs",
      "#mega-menu-item-365 > a.mega-menu-link",
      "#mega-menu-item-365 ul.mega-sub-menu",
      "#mega-menu-item-365 ul.mega-sub-menu a.mega-menu-link"
    );

    // Verify the "Getting Started" menu
    await verifyMenu(
      "Getting Started",
      "#mega-menu-item-366 > a.mega-menu-link",
      "#mega-menu-item-366 ul.mega-sub-menu",
      "#mega-menu-item-366 ul.mega-sub-menu a.mega-menu-link"
    );
  });
});
