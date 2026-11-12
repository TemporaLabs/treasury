# Build, bundles and release

What `npm run build` produces, which outputs are committed and why, the plugin folder, the generated
files, and the CI checks that hold all of them to a fresh build. Shipping a release (version bump,
tag, npm publish, verifying both channels) is [`../../release-process.md`](../../release-process.md);
checking that an installed bundle is the one CI built is
[`../../runbooks/verify_the_bundle.md`](../../runbooks/verify_the_bundle.md).

| guide | read it when |
|---|---|
| [`01-build-and-bundles.md`](01-build-and-bundles.md) | you change the build, anything under `connect-page/`, the plugin folder, or a file CI regenerates |
