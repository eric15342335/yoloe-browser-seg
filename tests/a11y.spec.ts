import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('initial UI has no automated WCAG A/AA violations', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'YOLOE local visual prompt' })).toBeVisible()

  const scan = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  expect(scan.violations).toEqual([])
})
