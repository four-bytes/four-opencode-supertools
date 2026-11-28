<?php

namespace App\Controller;

use Symfony\Component\Routing\Attribute\Route;

/**
 * Docblock mentioning /api/orders must stay untouched.
 */
// Comment mentioning /api/orders must stay untouched.
#[AsRoute('/api/orders')]
class UntouchedController
{
    #[Route('/other')]
    public function other(): void
    {
    }
}
