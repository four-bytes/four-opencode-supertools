<?php

namespace App\Controller;

use Symfony\Component\Routing\Attribute\Route;

class PositionalController
{
    #[Route('/api/orders', methods: ['GET'])]
    public function index(): void
    {
    }
}
