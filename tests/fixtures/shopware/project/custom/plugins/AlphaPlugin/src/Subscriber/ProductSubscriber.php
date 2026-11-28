<?php declare(strict_types=1);

namespace AlphaPlugin\Subscriber;

use Symfony\Component\EventDispatcher\EventSubscriberInterface;

class ProductSubscriber implements EventSubscriberInterface
{
    public static function getSubscribedEvents(): array
    {
        return ['product.written' => 'onProductWritten'];
    }

    public function onProductWritten(): void
    {
    }
}
