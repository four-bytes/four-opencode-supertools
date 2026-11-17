<?php

namespace App;

class Widget
{
    public const KIND = 'widget';
}

class Factory
{
    public function make(): Widget
    {
        $widget = new Widget();
        $kind = Widget::KIND;
        if ($widget instanceof Widget) {
            return $widget;
        }

        return $widget;
    }
}
