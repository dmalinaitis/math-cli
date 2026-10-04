I'm assuming you mean the **Einstein field equations**, the central formula of general relativity.

## The equation

$$G_{\mu\nu} + \Lambda g_{\mu\nu} = \frac{8\pi G}{c^4} T_{\mu\nu}$$

where

$$G_{\mu\nu} = R_{\mu\nu} - \tfrac12 R\, g_{\mu\nu}.$$

The slogan is: matter tells spacetime how to curve, and curved spacetime tells matter how to move. It is a set of 10 coupled nonlinear PDEs for the metric.

## The ingredients

**Metric** $g_{\mu\nu}$. This is the fundamental unknown.

**Christoffel symbols.** They are built from first derivatives of the metric and encode how basis vectors change from point to point:

$$\Gamma^\lambda_{\mu\nu} = \tfrac12 g^{\lambda\sigma}\left(\partial_\mu g_{\sigma\nu} + \partial_\nu g_{\sigma\mu} - \partial_\sigma g_{\mu\nu}\right).$$

Free-falling particles follow geodesics:

$$\frac{d^2x^\lambda}{d\tau^2} + \Gamma^\lambda_{\mu\nu}\frac{dx^\mu}{d\tau}\frac{dx^\nu}{d\tau} = 0.$$

**Riemann tensor.** Curvature measured by parallel transport around a loop:

$$R^\rho{}_{\sigma\mu\nu} = \partial_\mu \Gamma^\rho_{\nu\sigma} - \partial_\nu \Gamma^\rho_{\mu\sigma} + \Gamma^\rho_{\mu\lambda}\Gamma^\lambda_{\nu\sigma} - \Gamma^\rho_{\nu\lambda}\Gamma^\lambda_{\mu\sigma}$$

Contracting gives the Ricci tensor and scalar:

$$R_{\mu\nu} = R^\lambda{}_{\mu\lambda\nu}, \qquad R = g^{\mu\nu}R_{\mu\nu}.$$

## Checks

- The Bianchi identity gives $\nabla^\mu G_{\mu\nu} = 0$, so $\nabla^\mu T_{\mu\nu} = 0$.
- In the weak-field limit $g_{00} \approx -(1 + 2\Phi/c^2)$ and the field equations reduce to

$$\nabla^2 \Phi = 4\pi G \rho.$$

Done.