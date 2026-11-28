<?php

namespace App\Controller;

use Symfony\Component\Routing\Attribute\Route;

class NamedSingleController
{
    #[Route(path: '/api/orders')]
    public function index(): void
    {
    }
}
