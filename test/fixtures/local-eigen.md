To find the eigenvalues and eigenvectors of the matrix $A = \begin{pmatrix} 2 & 1 \\ 1 & 2 \end{pmatrix}$, we will proceed in two main steps: first determining the eigenvalues via the characteristic polynomial, and then finding the corresponding eigenvectors.

### 1. The Characteristic Polynomial

The eigenvalues $\lambda$ are the roots of the **characteristic polynomial**, defined as:
$$ p(\lambda) = \det(A - \lambda I) $$
where $I$ is the identity matrix.

Substituting our matrix $A$:
$$ A - \lambda I = \begin{pmatrix} 2 & 1 \\ 1 & 2 \end{pmatrix} - \begin{pmatrix} \lambda & 0 \\ 0 & \lambda \end{pmatrix} = \begin{pmatrix} 2-\lambda & 1 \\ 1 & 2-\lambda \end{pmatrix} $$

Now, we calculate the determinant:
$$ p(\lambda) = \det \begin{pmatrix} 2-\lambda & 1 \\ 1 & 2-\lambda \end{pmatrix} $$
$$ p(\lambda) = (2-\lambda)(2-\lambda) - (1)(1) $$
$$ p(\lambda) = (2-\lambda)^2 - 1 $$

Expanding this expression:
$$ p(\lambda) = (4 - 4\lambda + \lambda^2) - 1 $$
$$ p(\lambda) = \lambda^2 - 4\lambda + 3 $$

**Explanation of the Polynomial:**
The characteristic polynomial is a quadratic equation derived from the condition that the matrix $A-\lambda I$ must be singular (non-invertible) for a non-zero vector to exist such that $(A-\lambda I)\mathbf{v} = \mathbf{0}$. The roots of this polynomial give us the eigenvalues.

To find the roots, we factor the quadratic:
$$ \lambda^2 - 4\lambda + 3 = (\lambda - 3)(\lambda - 1) = 0 $$

Thus, the eigenvalues are:
$$ \lambda_1 = 3, \quad \lambda_2 = 1 $$

---

### 2. Finding the Eigenvectors

For each eigenvalue $\lambda$, we solve the system $(A - \lambda I)\mathbf{v} = \mathbf{0}$ for the eigenvector $\mathbf{v} = \begin{pmatrix} x \\ y \end{pmatrix}$.

#### Case 1: $\lambda_1 = 3$

Substitute $\lambda = 3$ into $A - \lambda I$:
$$ A - 3I = \begin{pmatrix} 2-3 & 1 \\ 1 & 2-3 \end{pmatrix} = \begin{pmatrix} -1 & 1 \\ 1 & -1 \end{pmatrix} $$

We solve:
$$ \begin{pmatrix} -1 & 1 \\ 1 & -1 \end{pmatrix} \begin{pmatrix} x \\ y \end{pmatrix} = \begin{pmatrix} 0 \\ 0 \end{pmatrix} $$

This yields the equation:
$$ -x + y = 0 \implies x = y $$

The second row gives $x - y = 0$, which is the same equation. We can choose a free variable. Let $y = 1$, then $x = 1$.
So, an eigenvector corresponding to $\lambda_1 = 3$ is:
$$ \mathbf{v}_1 = \begin{pmatrix} 1 \\ 1 \end{pmatrix} $$
*(Any non-zero scalar multiple of this vector is also an eigenvector).*

#### Case 2: $\lambda_2 = 1$

Substitute $\lambda = 1$ into $A - \lambda I$:
$$ A - 1I = \begin{pmatrix} 2-1 & 1 \\ 1 & 2-1 \end{pmatrix} = \begin{pmatrix} 1 & 1 \\ 1 & 1 \end{pmatrix} $$

We solve:
$$ \begin{pmatrix} 1 & 1 \\ 1 & 1 \end{pmatrix} \begin{pmatrix} x \\ y \end{pmatrix} = \begin{pmatrix} 0 \\ 0 \end{pmatrix} $$

This yields the equation:
$$ x + y = 0 \implies x = -y $$

Let $y = 1$, then $x = -1$.
So, an eigenvector corresponding to $\lambda_2 = 1$ is:
$$ \mathbf{v}_2 = \begin{pmatrix} -1 \\ 1 \end{pmatrix} $$
*(Alternatively, one could choose $\begin{pmatrix} 1 \\ -1 \end{pmatrix}$).*

---

### Final Conclusion

The eigenvalues and eigenvectors of the matrix $A = \begin{pmatrix} 2 & 1 \\ 1 & 2 \end{pmatrix}$ are:

1.  **Eigenvalue** $\lambda_1 = 3$ with **Eigenvector** $\mathbf{v}_1 = \begin{pmatrix} 1 \\ 1 \end{pmatrix}$.
2.  **Eigenvalue** $\lambda_2 = 1$ with **Eigenvector** $\mathbf{v}_2 = \begin{pmatrix} -1 \\ 1 \end{pmatrix}$.

The characteristic polynomial is $p(\lambda) = \lambda^2 - 4\lambda + 3$, which factors as $(\lambda-3)(\lambda-1)$, confirming the eigenvalues found above.