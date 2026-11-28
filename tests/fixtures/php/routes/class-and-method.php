<?php

namespace App\Controller;

use Symfony\Component\Routing\Attribute\Route;

#[Route('/api/orders')]
class ClassAndMethodController
{
    #[Route('/api/orders', methods: ['GET'])]
    public function list(): void
    {
    }
}
