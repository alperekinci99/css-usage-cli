# css-usage-cli

Zero-dependency CLI to find and prune unused CSS classes.  
Optional SCSS support via user-installed `sass`.

```bash
# basic usage
npx css-usage-cli ./src ./src/styles.css

# prune unused
npx css-usage-cli ./src ./src/styles.css --remove --out ./src/pruned.css