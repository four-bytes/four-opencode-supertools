<?php

class Outer
{
    public function target(): void
    {
    }

    public function build(): object
    {
        $this->target();
        return new class {
            public function target(): void
            {
            }

            public function call(): void
            {
                $this->target();
            }
        };
    }
}
