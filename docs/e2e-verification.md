# Browser E2E verification

The complete import and editing flow was exercised in the real web UI with a deterministic local provider and anonymous, code-generated garment and model fixtures. This verifies the application pipeline, persistence, request counts, review rules, and navigation. Live AI classification, generated-photo fidelity, and physical-device behavior were not tested by this run.

## Reproduce

```bash
npm install
npm test
npm run check
npm run e2e:serve
```

Open the printed URL, `http://127.0.0.1:5175/`, in a fresh browser context. The launcher prints three temporary input file paths and serves them at `/__e2e/inputs/blue-flannel-shirt.png`, `/__e2e/inputs/rust-cotton-tee.png`, and `/__e2e/inputs/formal-dress-shirt.png`. It starts with two synthetic trousers. All imports and identity references use an isolated temporary folder; the launcher does not load `.env`, use a real API key, or modify `data/`. Stop with Ctrl+C to close both servers and delete that folder. The port is strict: startup fails if 5175 is occupied.

1. Upload the blue flannel through **Add clothes**, approve its crop and garment, then review both modeled images. Check the shirt and layer fields are selected. **Approve** must remain disabled until the second photo loads.
2. Open the saved flannel. Hover over the cover, use the next arrow, then focus the carousel and press ArrowLeft. Turn **Can wear as a layer** off, save, reload, and verify the choice and both accepted photos remain.
3. Import the tee and formal dress shirt through the same approval flow. Each starts with one modeled photo. The tee has neither shirt field selected; the dress shirt is a shirt with layer suitability off.
4. For the dress shirt, enable **Can wear as a layer**, save, and choose **Create layer look**. Review and approve the new open look. The item ID and accepted closed-photo URL must remain unchanged.
5. Repeat gallery navigation at a 390 × 844 viewport with coarse-pointer emulation. Check the arrows, title position, touch targets, and horizontal overflow.

Inspect `/__e2e` for fixture provider requests and the persisted library. This is a manual browser test harness, not an automated browser test runner.

## Observed results

| Flow | Result |
| --- | --- |
| Flannel import | Crop → garment → two reviewed modeled photos; one wardrobe item; classification source `ai` |
| Approval gate | Disabled after the first photo; enabled after the second was viewed |
| Carousel | Arrows changed from opacity 0 to 1 on hover, with a 60% opaque background; next-arrow and ArrowLeft navigation passed |
| Manual override | Layer suitability stayed off after save/reload; source became `manual`; existing photos were retained |
| Tee and dress-shirt imports | Tee: `false / false`, one photo. Dress shirt: `true / false`, one photo |
| Add missing layer look | Exactly one new modeled request; closed-photo URL reused; same item ID; two approved photos; no extra inventory item |
| Provider totals | 3 classification requests, 3 garment requests, 5 modeled requests |
| Final inventory | 5 items: two seeded trousers and three imported tops |
| Trouser sizing | Visible heights were 189.395 px and 189.425 px for the same-size fixtures |
| Titles and touch layout | Titles stayed below garment photos on desktop and narrow screens; 390 px page width had no horizontal overflow; 44 × 44 px arrow targets stayed within the viewport; touch next-arrow navigation passed |

## Screenshots

![Flannel garment review with both shirt controls selected](screenshots/layering-import-review.png)

The flannel's provider-supplied shirt and layer suitability are prefilled during import review.

![Reviewing the flannel's second modeled image](screenshots/layering-pair-review.png)

Both closed and open modeled views are available before the pair is approved.

![Saved flannel displayed as an open layer](screenshots/layering-carousel-open.png)

The saved item carousel displays the open look over an inner top and retains one wardrobe item.

![Narrow-screen wardrobe item carousel](screenshots/layering-touch.png)

The carousel remains usable in a 390 × 844 coarse-pointer browser viewport. This screenshot is browser emulation, not a physical-phone test.
