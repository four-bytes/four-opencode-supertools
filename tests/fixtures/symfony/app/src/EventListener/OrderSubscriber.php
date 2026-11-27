<?php

declare(strict_types=1);

namespace App\EventListener;

use Symfony\Component\EventDispatcher\EventSubscriberInterface;

final class OrderSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return [
            'order.created' => [['onCreatedHigh', 20], ['onCreatedLow', 0]],
            'kernel.request' => 'onRequest',
        ];
    }

    public function onCreatedHigh(): void
    {
    }

    public function onCreatedLow(): void
    {
    }

    public function onRequest(): void
    {
    }
}
